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
  /** Dreamer classify-memories outputs (v44). importance (1-100) drives
   *  budget-trim ordering; scope/shareable are advisory. Defaults 50/"project"/
   *  false on pre-v44 plugin DBs (the dashboard never migrates). */
  importance: number;
  scope: MemoryScope;
  shareable: boolean;
  has_embedding: boolean;
  source_display_name?: string | null;
}

export type MemoryScope = "project" | "ecosystem" | "universe";

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

export interface Primer {
  id: number;
  project_path: string;
  question: string;
  answer: string;
  status: "active" | "archived";
  total_support: number;
  last_observed_at: number | null;
  answer_refreshed_at: number | null;
  source_candidate_ids: string;
  created_at: number;
  updated_at: number;
}

export interface PrimerCandidate {
  id: number;
  project_path: string;
  question: string;
  session_id: string;
  source_compartment_start: number | null;
  source_compartment_end: number | null;
  source_message_time: number;
  created_at: number;
}

export interface MuralManifest {
  project_path: string;
  /** PNG BLOB serialized by Tauri as a byte array, or a data URL from a server transport. */
  image: number[] | string;
  rendered_at: number;
  token_estimate: number;
  width: number;
  height: number;
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

export type Harness = "opencode" | "opencode2" | "pi" | "omp" | "broca" | "claude_code" | "codex";

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
  last_activity_ms: number;
  is_subagent: boolean;
}

export interface SessionScanCondition {
  code: string;
  message: string;
}

export interface PagedSessions {
  rows: SessionRow[];
  total: number;
  has_more: boolean;
  conditions: SessionScanCondition[];
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

export interface ProjectRow {
  identity: string;
  display_name: string;
  primary_path: string;
  harnesses: Harness[];
  session_count: number;
}

export interface ProjectCard {
  identity: string;
  display_name: string;
  primary_path: string;
  harnesses: Harness[];
  session_count: number;
  memory_count: number;
  workspace_name: string | null;
  last_activity_ms: number;
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
  /** v2 decay-rate score (1–100). Higher decays into lower tiers slower. */
  importance: number;
  /** v2 episode classification — may be comma-joined (e.g. "design,bug"). */
  episode_type?: string;
  /** v2 paraphrase tiers (P1 verbose → P4 anchor-only). Null/empty for legacy rows. */
  p1?: string;
  p2?: string;
  p3?: string;
  p4?: string;
  /** 1 = legacy pre-v2 compartment (no real tiers); 0 = v2 tiered. */
  legacy: number;
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
  cache_ttl: string | number | null;
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
  new_work_tokens: number;
  total_input_tokens: number;
}

export interface SubagentInvocation {
  id: number;
  session_id: string;
  harness: string;
  subagent: string;
  task: string | null;
  provider_id: string | null;
  model_id: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  error: string | null;
  parent_invocation_id: number | null;
}

export interface SubagentTotals {
  subagent: string;
  invocations: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
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

/** Dreamer v2 per-task schedule state (one row per project+task). */
export interface TaskScheduleEntry {
  project_path: string;
  task: string;
  last_run_at: number | null;
  next_due_at: number | null;
  last_status: "completed" | "failed" | "skipped" | null;
  last_error: string | null;
  retry_count: number;
}

export interface DreamStateEntry {
  key: string;
  value: string;
}

export interface DreamerProjectTask {
  task: string;
  schedule: string | null;
  last_run_at: number | null;
  next_due_at: number | null;
  last_status: "completed" | "failed" | "skipped" | null;
  last_error: string | null;
  retry_count: number;
}

export interface DreamerProject {
  identity: string;
  label: string;
  /** Worktree dir for per-project config read/write; null when unresolvable. */
  worktree: string | null;
  config_path: string | null;
  /** True when this project declares its own `dreamer` block (vs inherits global). */
  has_project_config: boolean;
  tasks: DreamerProjectTask[];
}

export type DreamRunFailureClass =
  | "provider_timeout"
  | "provider_error"
  | "empty_completion"
  | "no_models"
  | "child_aborted"
  | "parse_failed"
  | "unknown";

export interface DreamRunFailureDetail {
  failure_class: DreamRunFailureClass;
  model_attempted: string | null;
  models_tried: string[];
  provider_error: string | null;
  timeout_ms: number | null;
  child_session_id: string | null;
}

export interface DreamRunTask {
  name: string;
  durationMs: number;
  resultChars: number;
  /** Failure detail only. Missing means no failure was recorded; an empty
   * string is treated as absent by the dashboard. */
  error?: string;
  failure?: DreamRunFailureDetail;
  /** Successful progress/detail. Missing means no progress was reported; an
   * empty string is treated as absent by the dashboard. */
  progress?: string;
  backlog?: {
    pendingAtStart: number;
    totalAtStart: number;
    pendingAtEnd: number;
    totalAtEnd: number;
    processed: number;
  };
  tokens?: {
    total: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
}

export interface DreamRunMemoryChanges {
  written?: number;
  deleted?: number;
  archived?: number;
  merged?: number;
}

export interface DreamMemoryChange {
  id: number;
  category: string;
  content: string;
  status: string;
}

export interface DreamRunMemoryDetail {
  written: DreamMemoryChange[];
  archived: DreamMemoryChange[];
  merged: DreamMemoryChange[];
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
  level: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | null;
  /** Message-derived bucket (event/transform/dreamer/…) the log page filters on. */
  component: string;
  /**
   * Dotted logger name a fleet r2 line writes before its colon
   * (`magic-context.historian`); the bare module id on older lines.
   */
  logger: string;
  session_id: string;
  tags: string[];
  /** Context bound for a scope (harness, session, agent, root) rather than for one event. */
  bound: Record<string, string>;
  message: string;
  kv: Record<string, string>;
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
  cache_reported: boolean;
  total_tokens: number;
  hit_ratio: number;
  severity:
    | "stable"
    | "info"
    | "warning"
    | "bust"
    | "full_bust"
    | "warming"
    | "unknown"
    | "aggregate";
  cause: string | null;
  agent: string | null;
  finish?: string;
  turn_id: string;
  is_turn_start: boolean;
  context_limit: number;
  /** True when `context_limit` is the max-prompt fallback (no recorded limit).
   *  The fallback is batch-local and climbs on the incremental fetch path, so
   *  estimated limits must be collapsed to a stable per-session value before
   *  segmenting/scaling the timeline (see normalizeEstimatedContextLimits). */
  context_limit_estimated: boolean;
  is_drop: boolean;
  /** True when the row sums several provider requests (a whole Broca run)
   *  rather than describing one. `hit_ratio` is then the run's total cached
   *  share and `severity` is "aggregate"; it is never a STABLE/BUST verdict. */
  aggregate: boolean;
  /** True for a session's first row: its opening request could not read the
   *  cache, so a low share there is a cold start, not a miss. */
  cold_start: boolean;
  /** False when the source omitted the cache-write count, so `cache_write`
   *  is an absent value rather than a reported zero. */
  cache_write_reported: boolean;
  /** Provider and model that served the request (for a Broca run total, the
   *  run's last segment). Null when the source does not record them. */
  provider: string | null;
  model: string | null;
}

export interface SessionCacheStats {
  harness: Harness;
  session_id: string;
  event_count: number;
  total_cache_read: number;
  total_cache_write: number;
  total_input: number;
  hit_ratio: number;
  last_timestamp: string;
  last_activity_ms: number;
  bust_count: number;
  managed: boolean;
  is_subagent: boolean;
  title: string | null;
  /** Set when this session's activity time cannot follow a running turn. */
  activity_note?: string | null;
}

export interface ConfigFile {
  path: string;
  exists: boolean;
  content: string | null;
  source: string;
  error?: string | null;
}

export type OpencodeInstallState = "cli" | "desktop" | "none";

/** Harness-scoped model catalogs returned together by the Tauri backend. */
export interface ModelCatalogs {
  opencode: string[];
  pi: string[];
  omp: string[];
  opencodeError?: string | null;
}

export interface ProjectConfigEntry {
  project_name: string;
  worktree: string;
  config_path: string;
  exists: boolean;
  alt_config_path?: string | null;
  alt_exists?: boolean;
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

export type WorkspaceShareCategory =
  | "PROJECT_RULES"
  | "ARCHITECTURE"
  | "CONSTRAINTS"
  | "CONFIG_VALUES"
  | "NAMING";

export interface WorkspaceMemberView {
  project_path: string;
  display_name: string;
  display_path: string;
  memory_count: number;
  added_at: number;
}

export interface WorkspaceListItem {
  id: number;
  name: string;
  created_at: number;
  updated_at: number;
  share_categories: WorkspaceShareCategory[];
  members: WorkspaceMemberView[];
}

export interface WorkspaceSummary {
  id: number;
  name: string;
}

/** Top-level sidebar sections. Sessions / Memories / Dreamer / Primers are no
 *  longer top-level — they live inside a project (see ProjectTab). */
export type NavSection = "projects" | "workspaces" | "cache" | "user-memories" | "config" | "logs";

/** Sub-tabs shown inside a project's detail view. */
export type ProjectTab = "sessions" | "memories" | "dreamer" | "primers";
