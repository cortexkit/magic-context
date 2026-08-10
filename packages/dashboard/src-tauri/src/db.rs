use rusqlite::{
    params, params_from_iter, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};

use crate::external_cache_sessions;
use crate::pi_sessions;
use crate::project_identity::{basename, normalize_stored_project_path};

pub fn resolve_db_path() -> Option<PathBuf> {
    // The magic-context plugin uses XDG_DATA_HOME or ~/.local/share on ALL platforms
    // (see packages/plugin/src/shared/data-path.ts). On Windows this means
    // C:\Users\<user>\.local\share — NOT %APPDATA%.
    //
    // Plugin v0.16+ stores data at the shared cortexkit path (cross-harness:
    // OpenCode + Pi share one DB). Older OpenCode-only installs lived under
    // opencode/storage/plugin/magic-context. We prefer the new location and
    // fall back to the legacy path so the dashboard keeps working when the
    // user hasn't restarted OpenCode since the upgrade.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });

    let shared_path = data_dir
        .join("cortexkit")
        .join("magic-context")
        .join("context.db");
    if shared_path.exists() {
        return Some(shared_path);
    }

    let legacy_path = data_dir
        .join("opencode")
        .join("storage")
        .join("plugin")
        .join("magic-context")
        .join("context.db");
    if legacy_path.exists() {
        Some(legacy_path)
    } else {
        None
    }
}

pub fn resolve_opencode_db_path() -> Option<PathBuf> {
    // OpenCode also uses XDG_DATA_HOME or ~/.local/share on all platforms.
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });
    let db_path = data_dir.join("opencode").join("opencode.db");
    if db_path.exists() {
        Some(db_path)
    } else {
        None
    }
}

/// Opens a read-only connection to the database in WAL mode.
pub fn open_readonly(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // WAL mode is inherited from the plugin's read-write connection — no need to set it here.
    // busy_timeout is connection-local and safe on read-only connections.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    Ok(conn)
}

fn ensure_context_store_uuid(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_table: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_store_meta'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if has_table.is_none() {
        return Ok(());
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM context_store_meta WHERE key = 'store_uuid'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        return Ok(());
    }
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            error.to_string(),
        )))
    })?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    );
    conn.execute(
        "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?1) ON CONFLICT(key) DO NOTHING",
        [&uuid],
    )?;
    Ok(())
}

/// Opens a read-write connection for write operations (memory edits, queue entries).
pub fn open_readwrite(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    // READ_WRITE WITHOUT CREATE: if the DB file vanished after startup,
    // Connection::open would CREATE an empty SQLite file — violating the
    // "dashboard never owns the schema" boundary. The plugin owns DB lifecycle;
    // a missing file should error, not silently spawn a blank DB.
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // busy_timeout MUST come before journal_mode=WAL: setting WAL can itself need
    // the file lock, and with the timeout installed last a cold-open under
    // contention fails immediately with SQLITE_BUSY instead of waiting.
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // This opener has no module client, so a marker-less store cannot be classified as
    // regressed here. The later module handshake performs the authoritative reconciliation.
    ensure_context_store_uuid(&conn)?;
    Ok(conn)
}

// ── Memory types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Memory {
    pub id: i64,
    pub project_path: String,
    pub category: String,
    pub content: String,
    pub normalized_hash: String,
    pub source_session_id: Option<String>,
    pub source_type: String,
    pub seen_count: i64,
    pub retrieval_count: i64,
    pub first_seen_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub last_retrieved_at: Option<i64>,
    pub status: String,
    pub expires_at: Option<i64>,
    pub verification_status: String,
    pub verified_at: Option<i64>,
    pub superseded_by_memory_id: Option<i64>,
    pub merged_from: Option<String>,
    pub metadata_json: Option<String>,
    /// Dreamer classify-memories outputs (v44). importance drives budget-trim
    /// ordering; scope/shareable are advisory.
    pub importance: i64,
    pub scope: String,
    pub shareable: bool,
    pub has_embedding: bool,
    /// Member `display_name` when listing memories under a workspace filter.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_display_name: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryStats {
    pub total: i64,
    pub active: i64,
    pub permanent: i64,
    pub archived: i64,
    pub with_embeddings: i64,
    pub categories: Vec<CategoryCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Primer {
    pub id: i64,
    pub project_path: String,
    pub question: String,
    pub answer: String,
    pub status: String,
    pub total_support: i64,
    pub last_observed_at: Option<i64>,
    pub answer_refreshed_at: Option<i64>,
    pub source_candidate_ids: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct PrimerCandidate {
    pub id: i64,
    pub project_path: String,
    pub question: String,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub source_message_time: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct MuralManifest {
    pub project_path: String,
    pub image: Vec<u8>,
    pub rendered_at: i64,
    pub token_estimate: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct CategoryCount {
    pub category: String,
    pub count: i64,
}

// ── Session types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub project_identity: Option<String>,
    pub compartment_count: i64,
    pub fact_count: i64,
    pub note_count: i64,
    pub first_compartment_start: Option<i64>,
    pub last_compartment_end: Option<i64>,
    pub last_response_time: Option<i64>,
    pub last_context_percentage: Option<f64>,
    pub is_subagent: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Harness {
    Opencode,
    Pi,
    ClaudeCode,
    Codex,
}

impl Harness {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Pi => "pi",
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    fn has_magic_context_plugin_state(self) -> bool {
        matches!(self, Self::Opencode | Self::Pi)
    }

    fn uses_codex_no_write_cache_model(self) -> bool {
        matches!(self, Self::Codex)
    }
}

impl std::str::FromStr for Harness {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "opencode" => Ok(Self::Opencode),
            "pi" => Ok(Self::Pi),
            "claude_code" | "claude-code" | "claudecode" | "cc" => Ok(Self::ClaudeCode),
            "codex" => Ok(Self::Codex),
            other => Err(format!("unknown harness: {other}")),
        }
    }
}

type SessionIdentityMap = HashMap<(Harness, String), String>;

fn load_session_identity_map() -> SessionIdentityMap {
    let Some(db_path) = resolve_db_path() else {
        return HashMap::new();
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return HashMap::new();
    };
    load_session_identity_map_from_conn(&conn)
}

fn load_session_identity_map_from_conn(conn: &Connection) -> SessionIdentityMap {
    let mut map = HashMap::new();
    if !table_exists(conn, "session_projects") {
        return map;
    }
    let Ok(mut stmt) =
        conn.prepare("SELECT session_id, harness, project_path FROM session_projects")
    else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return map;
    };
    for row in rows.flatten() {
        let (session_id, harness_raw, identity) = row;
        let Ok(harness) = harness_raw.parse::<Harness>() else {
            continue;
        };
        map.insert((harness, session_id), identity);
    }
    map
}

fn lookup_session_identity(
    identities: &SessionIdentityMap,
    harness: Harness,
    session_id: &str,
) -> String {
    identities
        .get(&(harness, session_id.to_string()))
        .cloned()
        .unwrap_or_default()
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionFilter {
    pub harness: Option<Harness>,
    pub project_identity: Option<String>,
    pub search: Option<String>,
    /// `Some(true)` = subagents only, `Some(false)` = primary sessions only,
    /// `None` = no filter (return both). The dashboard "Subagents" toggle
    /// sends `Some(false)` when unchecked so subagents are filtered server-side.
    pub is_subagent: Option<bool>,
    pub offset: Option<u32>,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionRow {
    pub harness: Harness,
    pub session_id: String,
    pub title: String,
    pub project_identity: String,
    pub project_display: String,
    pub last_activity_ms: i64,
    pub is_subagent: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct PagedSessions {
    pub rows: Vec<SessionRow>,
    pub total: u32,
    pub has_more: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMessageRow {
    pub message_id: String,
    pub timestamp_ms: i64,
    pub role: String,
    pub text_preview: String,
    pub raw_json: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionDetail {
    pub harness: Harness,
    pub session_id: String,
    pub title: String,
    pub project_identity: String,
    pub project_display: String,
    pub project_path: Option<String>,
    pub opencode_session_json: Option<serde_json::Value>,
    pub pi_jsonl_path: Option<String>,
    /// Cheap row counts so badges can render without paying the cost of the
    /// underlying lists. Messages are pulled lazily by `get_session_messages`
    /// when the user activates the Messages tab; cache events by
    /// `get_session_cache_events` for the Cache tab. Both can be tens of
    /// thousands of rows for a long-running session and dominate IPC time.
    pub messages_count: i64,
    pub cache_events_count: i64,
    pub compartments: Vec<Compartment>,
    pub facts: Vec<SessionFact>,
    pub notes: Vec<Note>,
    pub meta: Option<SessionMetaRow>,
    pub token_breakdown: Option<ContextTokenBreakdown>,
    pub pi_compaction_entries: Vec<pi_sessions::PiCompactionEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProjectRow {
    pub identity: String,
    pub display_name: String,
    pub primary_path: String,
    pub harnesses: Vec<Harness>,
    pub session_count: u32,
}

/// Overview row for the Projects card grid. Session-derived (built from the same
/// `list_all_sessions` truth the Sessions tab uses, so counts/harnesses/last-active
/// match exactly on drill-in), enriched with the project's memory count and its
/// workspace membership.
#[derive(Debug, Serialize, Clone)]
pub struct ProjectCard {
    pub identity: String,
    pub display_name: String,
    pub primary_path: String,
    pub harnesses: Vec<Harness>,
    /// Primary (non-subagent) session count — what a user thinks of as "sessions".
    pub session_count: u32,
    pub memory_count: i64,
    /// The workspace this project belongs to, if any (members belong to ≤1).
    pub workspace_name: Option<String>,
    /// Newest primary-session activity; the grid sorts by this descending.
    pub last_activity_ms: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Compartment {
    pub id: i64,
    pub session_id: String,
    pub sequence: i64,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: Option<String>,
    pub end_message_id: Option<String>,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    /// Resolved from OpenCode DB using start_message_id
    pub start_time: Option<i64>,
    /// Resolved from OpenCode DB using end_message_id
    pub end_time: Option<i64>,
    /// v2 decay-rate score (1–100). Higher = decays into lower render tiers
    /// more slowly. Default 50.
    pub importance: i64,
    /// v2 episode classification — may be comma-joined (e.g. "design,bug").
    /// `None` for legacy rows.
    pub episode_type: Option<String>,
    /// v2 paraphrase tiers (P1 verbose → P4 anchor-only). `None`/empty for
    /// legacy rows that predate the tiered format.
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    /// 1 = legacy pre-v2 compartment (renders degraded, no real tiers);
    /// 0 = v2 tiered compartment.
    pub legacy: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionFact {
    pub id: i64,
    pub session_id: String,
    pub category: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct Note {
    pub id: i64,
    #[serde(rename = "type")]
    pub note_type: String,
    pub status: String,
    pub content: String,
    pub session_id: Option<String>,
    pub project_path: Option<String>,
    pub surface_condition: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_checked_at: Option<i64>,
    pub ready_at: Option<i64>,
    pub ready_reason: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionMetaRow {
    pub session_id: String,
    pub last_response_time: Option<i64>,
    pub cache_ttl: Option<String>,
    pub counter: i64,
    pub last_nudge_tokens: i64,
    pub last_nudge_band: String,
    pub is_subagent: bool,
    pub last_context_percentage: f64,
    pub last_input_tokens: i64,
    pub times_execute_threshold_reached: i64,
    pub compartment_in_progress: bool,
    pub system_prompt_hash: String,
    pub memory_block_count: i64,
    pub new_work_tokens: i64,
    pub total_input_tokens: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct SubagentInvocation {
    pub id: i64,
    pub session_id: String,
    pub harness: String,
    pub subagent: String,
    pub task: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub error: Option<String>,
    pub parent_invocation_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SubagentTotals {
    pub subagent: String,
    pub invocations: i64,
    pub total_input: i64,
    pub total_output: i64,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
}

// ── Dreamer types ──────────────────────────────────────────────

/// Dreamer v2 per-task schedule state (one row per project+task). Replaces the
/// retired project-level `dream_queue`. Read-only in the dashboard: manual runs
/// happen via `/ctx-dream` in the harness; the dashboard only reflects state.
#[derive(Debug, Serialize, Clone)]
pub struct TaskScheduleEntry {
    pub project_path: String,
    pub task: String,
    pub last_run_at: Option<i64>,
    pub next_due_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub retry_count: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamStateEntry {
    pub key: String,
    pub value: String,
}

/// One dreamer task's scheduled state for a project, as the dashboard project
/// card renders it. `schedule` is the active reconciled cron (the plugin writes
/// it each sweep from the effective merged config).
#[derive(Debug, Serialize, Clone)]
pub struct DreamerProjectTask {
    pub task: String,
    pub schedule: Option<String>,
    pub last_run_at: Option<i64>,
    pub next_due_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub retry_count: i64,
}

/// A tracked project for the dreamer page: its identity + friendly label, the
/// worktree directory used to read/write a per-project config (when resolvable),
/// whether it carries a per-project `dreamer` override (vs inheriting global),
/// and the per-task schedule state.
#[derive(Debug, Serialize, Clone)]
pub struct DreamerProject {
    pub identity: String,
    pub label: String,
    pub worktree: Option<String>,
    pub config_path: Option<String>,
    pub has_project_config: bool,
    pub tasks: Vec<DreamerProjectTask>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamRun {
    pub id: i64,
    pub project_path: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub holder_id: String,
    pub tasks_json: serde_json::Value,
    pub tasks_succeeded: i64,
    pub tasks_failed: i64,
    pub smart_notes_surfaced: i64,
    pub smart_notes_pending: i64,
    pub memory_changes_json: Option<serde_json::Value>,
    /// Dreamer child session that produced this run (Dreamer v2). Scopes the
    /// token join so concurrent same-name cross-project runs don't cross-sum.
    /// None for legacy rows written before the column existed.
    #[serde(skip)]
    pub parent_session_id: Option<String>,
}

// ── Note types ────────────────────────────────────────────────
// Unified Note struct replaces SessionNote and SmartNote
// Both session notes (type='session') and smart notes (type='smart') are stored in the notes table

// ── Context Token Breakdown ───────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ContextTokenBreakdown {
    pub total_input_tokens: i64,
    pub system_prompt_tokens: i64,
    pub compartment_tokens: i64,
    pub fact_tokens: i64,
    pub memory_tokens: i64,
    pub conversation_tokens: i64, // total - compartments - facts - memories - system_prompt
    pub compartment_count: i64,
    pub fact_count: i64,
    pub memory_count: i64,
}

// ── Cache diagnostics ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbCacheEvent {
    pub harness: Harness,
    pub message_id: String,
    pub session_id: String,
    pub timestamp: i64,
    pub input_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total_tokens: i64,
    pub hit_ratio: f64,
    pub severity: String,
    pub cause: Option<String>,
    pub agent: Option<String>,
    pub finish: Option<String>,
    pub turn_id: String,
    pub is_turn_start: bool,
    // The model's context window for this session (tokens), so the timeline can
    // scale each bar as prompt/context_limit. Resolved from the plugin's
    // last_usage_context_limit; falls back to the session's own max prompt
    // (auto-scale) when the plugin never recorded a limit for the session.
    pub context_limit: i64,
    // True when `context_limit` is the max-prompt FALLBACK (the plugin never
    // recorded a real limit for this session) rather than a recorded value. The
    // fallback is computed over whatever event batch reached this function, so on
    // the live incremental (since-based) fetch it CLIMBS as the session grows
    // (each delta's max ≈ the current prompt). The frontend must collapse these
    // to a single stable per-session value before scaling/segmenting, or the
    // timeline fragments into one box per step.
    pub context_limit_estimated: bool,
    // True when the prompt shrank meaningfully vs the previous step — i.e. Magic
    // Context reclaimed context (execute-pass drops, comparting). The `cause`
    // field carries the reason pulled from the plugin logs for these steps.
    pub is_drop: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SessionCacheStats {
    pub harness: Harness,
    pub session_id: String,
    pub event_count: usize,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_input: i64,
    pub hit_ratio: f64,
    pub last_timestamp: String,
    pub last_activity_ms: i64,
    pub bust_count: usize,
    pub managed: bool,
    pub is_subagent: bool,
    pub title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RawDbCacheEvent {
    harness: Harness,
    message_id: String,
    session_id: String,
    timestamp: i64,
    input_tokens: i64,
    cache_read: i64,
    cache_write: i64,
    total_tokens: i64,
    agent: Option<String>,
    finish: Option<String>,
    context_limit: Option<i64>,
}

#[derive(Debug, Clone)]
struct TransformDecisionCause {
    decision: String,
    materialize_reason: Option<String>,
    emergency: bool,
}

const MC_TRANSFORM_FAILED_OPEN_CAUSE: &str = "mc_transform_failed_open";
const UNATTRIBUTED_CACHE_BUST_CAUSE: &str = "Unattributed cache bust";

/// Estimate tokens using ~4 chars per token (CHARS_PER_TOKEN_ESTIMATE = 4)
fn estimate_tokens(chars: i64) -> i64 {
    (chars + 3) / 4 // Round up
}

/// Markdown heading overhead for compartments (approximate: `## start-end · title`).
const COMPARTMENT_HEADING_OVERHEAD: i64 = 24;

/// Extract the `<session-history>…</session-history>` block (inclusive of the
/// tags) from a rendered m[0] snapshot. Returns `None` if the block is absent
/// (e.g. a snapshot that predates materialization). This is the real on-wire
/// decayed compartment render, used to size the Compartments token bucket.
fn extract_session_history_slice(m0_text: &str) -> Option<String> {
    const OPEN: &str = "<session-history>";
    const CLOSE: &str = "</session-history>";
    let start = m0_text.find(OPEN)?;
    let end = m0_text[start..].find(CLOSE)? + start + CLOSE.len();
    Some(m0_text[start..end].to_string())
}

pub fn get_context_token_breakdown(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ContextTokenBreakdown>, rusqlite::Error> {
    // Get total input tokens and system prompt tokens from session_meta
    let (total_input_tokens, system_prompt_tokens): (i64, i64) = conn
        .query_row(
            "SELECT COALESCE(last_input_tokens, 0), COALESCE(system_prompt_tokens, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));

    // If no input tokens recorded, return None (no data available)
    if total_input_tokens == 0 {
        return Ok(None);
    }

    // Compartment count (for display) — always the real row count.
    let compartment_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM compartments WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // v2: compartments are DECAY-RENDERED — most render at a lower tier
    // (p2/p3/p4) or drop past the archive boundary, so the actual injected
    // <session-history> is far smaller than Σ(full p1 content). The true
    // on-wire size is the <session-history> slice of the persisted m[0]
    // snapshot (cached_m0_bytes). Measuring Σp1 instead overcounts the
    // Compartments bucket AND starves Conversation toward 0. Mirrors the
    // plugin sidebar fix (rpc-handlers.ts).
    let m0_bytes: Option<Vec<u8>> = conn
        .query_row(
            "SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let compartment_chars: i64 = m0_bytes
        .as_ref()
        .and_then(|b| String::from_utf8(b.clone()).ok())
        .and_then(|text| extract_session_history_slice(&text))
        .map(|slice| slice.len() as i64)
        .unwrap_or_else(|| {
            // No materialized m[0] yet (brand-new / pre-first-materialization).
            // Fall back to the Σp1 estimate so the bucket isn't blank on a cold
            // session; it self-corrects to the decayed size on first render.
            conn.query_row(
                "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + ?2), 0)
                 FROM compartments WHERE session_id = ?1",
                rusqlite::params![session_id, COMPARTMENT_HEADING_OVERHEAD],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });

    // v2: facts are retired as a render source (promoted to memories), so they
    // contribute 0 render tokens. fact_count stays available for display from
    // the vestigial session_facts table, but fact_chars is 0.
    let fact_chars: i64 = 0;
    let fact_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_facts WHERE session_id = ?1",
            [session_id],
            |r| r.get(0),
        )
        .unwrap_or(0);

    // Get memory block cache (rendered XML) and count from session_meta
    let (memory_cache_str, memory_count): (Option<String>, i64) = conn
        .query_row(
            "SELECT memory_block_cache, COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((None, 0));

    let memory_chars = memory_cache_str
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.len() as i64)
        .unwrap_or(0);

    // Estimate tokens
    let compartment_tokens = estimate_tokens(compartment_chars);
    let fact_tokens = estimate_tokens(fact_chars);
    let memory_tokens = estimate_tokens(memory_chars);

    // Conversation tokens = total - all known sections
    let known_tokens = system_prompt_tokens + compartment_tokens + fact_tokens + memory_tokens;
    let conversation_tokens = if total_input_tokens > known_tokens {
        total_input_tokens - known_tokens
    } else {
        0
    };

    Ok(Some(ContextTokenBreakdown {
        total_input_tokens,
        system_prompt_tokens,
        compartment_tokens,
        fact_tokens,
        memory_tokens,
        conversation_tokens,
        compartment_count,
        fact_count,
        memory_count,
    }))
}

// ── Database health ───────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct DbHealth {
    pub exists: bool,
    pub path: String,
    pub size_bytes: u64,
    pub wal_size_bytes: u64,
    pub table_counts: Vec<TableCount>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TableCount {
    pub table_name: String,
    pub row_count: i64,
}

// ── Helpers ───────────────────────────────────────────────────

/// Compute a normalized hash matching the plugin's dedup logic:
/// lowercase → trim whitespace → hash as hex string.
/// Uses std::hash for portability (no SHA crate in deps); the exact
/// hash algorithm doesn't matter as long as it's consistent within
/// the dashboard. The plugin uses its own Bun-based hash path.
/// Match the plugin's `computeNormalizedHash`: lowercase → collapse whitespace → trim → MD5 hex.
fn normalize_hash(content: &str) -> String {
    let normalized = content.to_lowercase();
    // Collapse all whitespace runs into a single space (mirrors JS /\s+/g → " ")
    let normalized: String = normalized.split_whitespace().collect::<Vec<_>>().join(" ");
    let digest = md5::compute(normalized.as_bytes());
    format!("{:032x}", digest)
}

fn format_timestamp_iso(timestamp: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| timestamp.to_string())
}

fn transform_decision_reason_label(reason: &str) -> Option<&'static str> {
    match reason {
        "system_hash" => Some("System prompt change"),
        "model_change" => Some("Model change"),
        "project_memory_epoch" => Some("Memory change"),
        "ttl_idle" => Some("Idle cache refresh"),
        "explicit_flush" => Some("Manual flush"),
        "max_mutation_id" => Some("History edit"),
        "first_render" => Some("First render"),
        "pressure_refold" => Some("Compaction pressure"),
        "upgrade_state" => Some("Session upgrade"),
        "cached_m1_missing" => Some("Cache rebuild"),
        "m1_delta" => Some("M1 delta"),
        "ttl_expiry" => Some("TTL expiry"),
        "epoch_change" => Some("Epoch change"),
        "coverage_fold" => Some("Coverage fold"),
        "profile_transition" => Some("Profile transition"),
        _ => None,
    }
}

fn transform_decision_cause(decision: Option<&TransformDecisionCause>) -> Option<String> {
    let decision = decision?;
    if decision.decision == "error" {
        return Some(MC_TRANSFORM_FAILED_OPEN_CAUSE.to_string());
    }
    if decision.emergency {
        return Some("Compaction pressure".to_string());
    }
    if let Some(reason) = decision.materialize_reason.as_deref() {
        return Some(
            transform_decision_reason_label(reason)
                .unwrap_or(reason)
                .to_string(),
        );
    }
    if decision.decision == "execute" {
        return Some("Execute pass (reclaimed tool output)".to_string());
    }
    None
}

pub fn load_raw_db_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Result<Vec<RawDbCacheEvent>, rusqlite::Error> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Ok(Vec::new());
    };

    let conn = open_readonly(&opencode_db_path)?;

    // Per-session windowing: each session gets up to `limit` recent events
    // (so a session-filtered timeline always has full bar coverage), capped
    // globally at `limit * 10` to bound memory across many concurrent sessions.
    // Without this, a 200-event global window split across e.g. 4 active
    // sessions left each session with only ~50 bars on the chart.
    let per_session_limit = limit as i64;
    let global_cap = per_session_limit.saturating_mul(10);

    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(since) =
        since_timestamp
    {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       CAST(json_extract(m.data, '$.finish') AS TEXT) AS finish,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
                  AND m.time_created > ?1
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish
            FROM ranked
            WHERE rn <= ?2
            ORDER BY time_created DESC
            LIMIT ?3".to_string(),
            vec![
                Box::new(since) as Box<dyn rusqlite::types::ToSql>,
                Box::new(per_session_limit),
                Box::new(global_cap),
            ],
        )
    } else {
        (
            "WITH ranked AS (
                SELECT CAST(m.id AS TEXT) AS msg_id,
                       m.session_id,
                       m.time_created,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) AS input_tokens,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) AS cache_read,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0) AS cache_write,
                       COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) AS total_tokens,
                       CAST(json_extract(m.data, '$.agent') AS TEXT) AS agent,
                       CAST(json_extract(m.data, '$.finish') AS TEXT) AS finish,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish
            FROM ranked
            WHERE rn <= ?1
            ORDER BY time_created DESC
            LIMIT ?2".to_string(),
            vec![
                Box::new(per_session_limit) as Box<dyn rusqlite::types::ToSql>,
                Box::new(global_cap),
            ],
        )
    };

    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(RawDbCacheEvent {
            harness: Harness::Opencode,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
            context_limit: None,
        })
    })?;

    rows.collect()
}

/// Load Pi cache events from JSONL session files. Mirrors the per-session
/// windowing the OpenCode SQL path does so a single noisy Pi session cannot
/// monopolize the global view, and emits the same `RawDbCacheEvent` shape as
/// OpenCode so downstream `build_db_cache_events` works unchanged.
pub fn load_raw_pi_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Vec<RawDbCacheEvent> {
    let per_session_limit = limit;
    let global_cap = limit.saturating_mul(10);
    let mut all_rows: Vec<RawDbCacheEvent> = Vec::new();

    for meta in pi_sessions::scan_pi_compatible_session_dir() {
        let Some(detail) = pi_sessions::read_pi_session_detail(&meta.jsonl_path) else {
            continue;
        };
        // Pi message timestamps are ms-since-epoch; the OpenCode side uses ms too,
        // so we keep them in the same unit and on the same time axis.
        let mut session_rows: Vec<RawDbCacheEvent> = detail
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .filter_map(|message| {
                let usage = message.usage.as_ref()?;
                if usage.total == 0 {
                    return None;
                }
                if let Some(since) = since_timestamp {
                    if message.timestamp_ms <= since {
                        return None;
                    }
                }
                Some(RawDbCacheEvent {
                    harness: Harness::Pi,
                    message_id: message.entry_id.clone(),
                    session_id: meta.session_id.clone(),
                    timestamp: message.timestamp_ms,
                    input_tokens: usage.input as i64,
                    cache_read: usage.cache_read as i64,
                    cache_write: usage.cache_write as i64,
                    total_tokens: usage.total as i64,
                    agent: None,
                    finish: message.stop_reason.clone(),
                    context_limit: None,
                })
            })
            .collect();
        // Per-session newest-first window so a long Pi session still surfaces
        // its latest events on the merged timeline.
        session_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
        session_rows.truncate(per_session_limit);
        all_rows.extend(session_rows);
    }

    all_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    all_rows.truncate(global_cap);
    all_rows
}

fn load_raw_claude_code_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Vec<RawDbCacheEvent> {
    load_raw_external_cache_events(
        Harness::ClaudeCode,
        external_cache_sessions::scan_claude_code_session_dir,
        external_cache_sessions::read_claude_code_session_detail,
        limit,
        since_timestamp,
    )
}

fn load_raw_codex_cache_events(limit: usize, since_timestamp: Option<i64>) -> Vec<RawDbCacheEvent> {
    load_raw_external_cache_events(
        Harness::Codex,
        external_cache_sessions::scan_codex_session_dir,
        external_cache_sessions::read_codex_session_detail,
        limit,
        since_timestamp,
    )
}

/// Claude Code and Codex store independent trees, so loading them concurrently
/// keeps the first diagnostics request from waiting for both JSONL parses in turn.
pub fn load_raw_external_cache_events_parallel(
    limit: usize,
    since_timestamp: Option<i64>,
) -> (Vec<RawDbCacheEvent>, Vec<RawDbCacheEvent>) {
    std::thread::scope(|scope| {
        let claude = scope.spawn(|| load_raw_claude_code_cache_events(limit, since_timestamp));
        let codex = scope.spawn(|| load_raw_codex_cache_events(limit, since_timestamp));
        let claude = match claude.join() {
            Ok(rows) => rows,
            Err(payload) => std::panic::resume_unwind(payload),
        };
        let codex = match codex.join() {
            Ok(rows) => rows,
            Err(payload) => std::panic::resume_unwind(payload),
        };
        (claude, codex)
    })
}

fn load_raw_external_cache_events(
    harness: Harness,
    scan: fn() -> Vec<external_cache_sessions::JsonlSessionMeta>,
    read_detail: fn(&std::path::Path) -> Option<Arc<external_cache_sessions::JsonlSessionDetail>>,
    limit: usize,
    since_timestamp: Option<i64>,
) -> Vec<RawDbCacheEvent> {
    let per_session_limit = limit;
    let global_cap = limit.saturating_mul(10);
    let mut all_rows: Vec<RawDbCacheEvent> = Vec::new();

    for meta in scan() {
        if since_timestamp.is_some_and(|since| {
            external_cache_sessions::source_file_mtime_is_not_newer_than(&meta, since)
        }) {
            continue;
        }
        let Some(detail) = read_detail(&meta.jsonl_path) else {
            continue;
        };
        let mut session_rows: Vec<RawDbCacheEvent> = detail
            .events
            .iter()
            .filter_map(|event| {
                if let Some(since) = since_timestamp {
                    if event.timestamp_ms <= since {
                        return None;
                    }
                }
                Some(RawDbCacheEvent {
                    harness,
                    message_id: event.message_id.clone(),
                    session_id: event.session_id.clone(),
                    timestamp: event.timestamp_ms,
                    input_tokens: event.input_tokens,
                    cache_read: event.cache_read,
                    cache_write: event.cache_write,
                    total_tokens: event.total_tokens,
                    agent: event.model.clone(),
                    finish: event.finish.clone(),
                    context_limit: event.context_limit,
                })
            })
            .collect();
        session_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
        session_rows.truncate(per_session_limit);
        all_rows.extend(session_rows);
    }

    all_rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    all_rows.truncate(global_cap);
    all_rows
}

/// Minimum prompt shrink (tokens) between consecutive steps to count as a
/// Magic-Context-initiated drop (vs token-accounting noise). MC reclaims are
/// large (tens of thousands+); this stays well above per-step jitter.
const DROP_MARKER_MIN_TOKENS: i64 = 15_000;

/// Resolve each session's model context window (tokens) from the plugin's
/// context.db `session_meta.last_usage_context_limit`. Read-only and
/// best-effort: a missing DB / column just yields an empty map, and the caller
/// auto-scales those sessions to their own max prompt instead.
fn resolve_session_context_limits(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), i64> {
    let mut out: HashMap<(Harness, String), i64> = HashMap::new();
    if keys.is_empty() {
        return out;
    }
    let Some(db_path) = resolve_db_path() else {
        return out;
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return out;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, harness, COALESCE(last_usage_context_limit, 0)
         FROM session_meta
         WHERE COALESCE(last_usage_context_limit, 0) > 0",
    ) else {
        return out;
    };
    let rows = stmt.query_map([], |row| {
        let sid: String = row.get(0)?;
        let harness_str: String = row.get(1)?;
        let limit: i64 = row.get(2)?;
        Ok((sid, harness_str, limit))
    });
    if let Ok(rows) = rows {
        for r in rows.flatten() {
            let Ok(harness) = r.1.parse::<Harness>() else {
                continue;
            };
            let key = (harness, r.0);
            if keys.contains(&key) {
                out.insert(key, r.2);
            }
        }
    }
    out
}

fn load_transform_decision_causes(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String, String), TransformDecisionCause> {
    if keys.is_empty() {
        return HashMap::new();
    }
    let Some(db_path) = resolve_db_path() else {
        return HashMap::new();
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return HashMap::new();
    };
    load_transform_decision_causes_from_conn(&conn, keys)
}

fn load_transform_decision_causes_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String, String), TransformDecisionCause> {
    let mut out: HashMap<(Harness, String, String), TransformDecisionCause> = HashMap::new();
    if keys.is_empty() {
        return out;
    }
    let session_ids: HashSet<String> = keys.iter().map(|(_, sid)| sid.clone()).collect();
    if session_ids.is_empty() {
        return out;
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, harness, message_id, decision, materialize_reason, emergency
         FROM transform_decisions
         WHERE session_id IN ({})",
        placeholders
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return out;
    };
    let rows = stmt.query_map(params_from_iter(session_ids.iter()), |row| {
        let session_id: String = row.get(0)?;
        let harness_str: String = row.get(1)?;
        let message_id: String = row.get(2)?;
        let decision: String = row.get(3)?;
        let materialize_reason: Option<String> = row.get(4)?;
        let emergency: i64 = row.get(5)?;
        Ok((
            session_id,
            harness_str,
            message_id,
            TransformDecisionCause {
                decision,
                materialize_reason,
                emergency: emergency != 0,
            },
        ))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let Ok(harness) = row.1.parse::<Harness>() else {
                continue;
            };
            let session_key = (harness, row.0.clone());
            if keys.contains(&session_key) {
                out.insert((harness, row.0, row.2), row.3);
            }
        }
    }
    out
}

fn load_transform_failure_sessions(
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    if keys.is_empty() {
        return HashSet::new();
    }
    let Some(db_path) = resolve_db_path() else {
        return HashSet::new();
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return HashSet::new();
    };
    load_transform_failure_sessions_from_conn(&conn, keys)
}

fn load_transform_failure_sessions_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    let mut out = HashSet::new();
    if keys.is_empty() {
        return out;
    }
    let session_ids: HashSet<String> = keys.iter().map(|(_, sid)| sid.clone()).collect();
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, harness
         FROM session_meta
         WHERE session_id IN ({})
           AND TRIM(COALESCE(last_transform_error, '')) != ''",
        placeholders
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return out;
    };
    let rows = stmt.query_map(params_from_iter(session_ids.iter()), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let Ok(harness) = row.1.parse::<Harness>() else {
                continue;
            };
            let key = (harness, row.0);
            if keys.contains(&key) {
                out.insert(key);
            }
        }
    }
    out
}

fn build_db_cache_events(rows: Vec<RawDbCacheEvent>, enrich_causes: bool) -> Vec<DbCacheEvent> {
    build_db_cache_events_with_attribution(rows, enrich_causes, None, None)
}

#[cfg(test)]
fn build_db_cache_events_with_decisions(
    rows: Vec<RawDbCacheEvent>,
    enrich_causes: bool,
    transform_decisions_override: Option<
        HashMap<(Harness, String, String), TransformDecisionCause>,
    >,
) -> Vec<DbCacheEvent> {
    build_db_cache_events_with_attribution(rows, enrich_causes, transform_decisions_override, None)
}

fn build_db_cache_events_with_attribution(
    rows: Vec<RawDbCacheEvent>,
    enrich_causes: bool,
    transform_decisions_override: Option<
        HashMap<(Harness, String, String), TransformDecisionCause>,
    >,
    transform_failure_sessions_override: Option<HashSet<(Harness, String)>>,
) -> Vec<DbCacheEvent> {
    // Build a map of earliest timestamp per session in our window so we can
    // detect whether an event is truly the session's first message vs just
    // the oldest event in the current 200-event window. Keyed by
    // (harness, session_id) because OC and Pi may share short ID prefixes
    // and must never alias each other in this analysis.
    let mut earliest_ts_in_window: HashMap<(Harness, String), i64> = HashMap::new();
    for row in &rows {
        earliest_ts_in_window
            .entry((row.harness, row.session_id.clone()))
            .and_modify(|ts| {
                if row.timestamp < *ts {
                    *ts = row.timestamp;
                }
            })
            .or_insert(row.timestamp);
    }

    // OC-side: probe each small session key through the
    // (session_id, time_created) index and stop at its first usable assistant
    // event. The previous GROUP BY evaluated JSON for every row in each giant
    // session every time its chart window or incremental overlap was loaded.
    let mut true_first_sessions: HashSet<(Harness, String)> = HashSet::new();
    let oc_session_ids: Vec<String> = earliest_ts_in_window
        .iter()
        .filter(|((h, _), _)| matches!(h, Harness::Opencode))
        .map(|((_, sid), _)| sid.clone())
        .collect();
    if !oc_session_ids.is_empty() {
        if let Some(opencode_db_path) = resolve_opencode_db_path() {
            if let Ok(conn) = open_readonly(&opencode_db_path) {
                if let Ok(mut stmt) = conn.prepare(FIRST_OPENCODE_CACHE_EVENT_SQL) {
                    for sid in oc_session_ids {
                        let db_earliest = stmt
                            .query_row(params![&sid], |row| row.get::<_, i64>(0))
                            .optional()
                            .ok()
                            .flatten();
                        let window_earliest =
                            earliest_ts_in_window.get(&(Harness::Opencode, sid.clone()));
                        if db_earliest
                            .zip(window_earliest)
                            .is_some_and(|(db, window)| *window <= db)
                        {
                            true_first_sessions.insert((Harness::Opencode, sid));
                        }
                    }
                }
            }
        }
    }

    // Pi-side: a Pi session has its true-first assistant message in our window
    // when our window-earliest timestamp for that Pi session is also the
    // earliest assistant timestamp in the underlying JSONL file. Read each Pi
    // session's first assistant timestamp once and compare.
    let mut pi_true_first: HashSet<(Harness, String)> = HashSet::new();
    let pi_sessions_in_window: Vec<String> = earliest_ts_in_window
        .iter()
        .filter(|((h, _), _)| matches!(h, Harness::Pi))
        .map(|((_, sid), _)| sid.clone())
        .collect();
    if !pi_sessions_in_window.is_empty() {
        // Build a lookup of Pi session_id -> jsonl path so we don't re-scan
        // the directory per session.
        let pi_meta_by_id: HashMap<String, std::path::PathBuf> =
            pi_sessions::scan_pi_compatible_session_dir()
                .into_iter()
                .map(|m| (m.session_id, m.jsonl_path))
                .collect();
        for sid in pi_sessions_in_window {
            let Some(path) = pi_meta_by_id.get(&sid) else {
                continue;
            };
            let Some(detail) = pi_sessions::read_pi_session_detail(path) else {
                continue;
            };
            let db_earliest = detail
                .messages
                .iter()
                .filter(|m| {
                    m.role == "assistant" && m.usage.as_ref().map(|u| u.total > 0).unwrap_or(false)
                })
                .map(|m| m.timestamp_ms)
                .min();
            if let (Some(db_earliest), Some(window_earliest)) = (
                db_earliest,
                earliest_ts_in_window.get(&(Harness::Pi, sid.clone())),
            ) {
                if *window_earliest <= db_earliest {
                    pi_true_first.insert((Harness::Pi, sid));
                }
            }
        }
    }
    let mut jsonl_true_first: HashSet<(Harness, String)> = HashSet::new();
    for (harness, first_lookup) in [
        (
            Harness::ClaudeCode,
            external_cache_sessions::claude_code_first_event_timestamp as fn(&str) -> Option<i64>,
        ),
        (
            Harness::Codex,
            external_cache_sessions::codex_first_event_timestamp as fn(&str) -> Option<i64>,
        ),
    ] {
        for ((_, sid), window_earliest) in earliest_ts_in_window
            .iter()
            .filter(|((h, _), _)| *h == harness)
        {
            if let Some(db_earliest) = first_lookup(sid) {
                if *window_earliest <= db_earliest {
                    jsonl_true_first.insert((harness, sid.clone()));
                }
            }
        }
    }

    let true_first_sessions: HashSet<(Harness, String)> = true_first_sessions
        .into_iter()
        .chain(pi_true_first)
        .chain(jsonl_true_first)
        .collect();

    // ── Pass 1: build chronological events (severity assigned in pass 2) ──
    // Cache health is classified by COMPARING each step against the PREVIOUS
    // step's accounting, not by a single-row ratio. A single-row ratio
    // (cache_read / total_prompt) conflates new uncached input — a big tool
    // result or a 30k file read — with cache loss: a perfectly healthy step
    // that merely added uncached input would wrongly read as WARNING. The
    // cross-step retention metric in pass 2 is immune to that and works across
    // providers without per-provider casing.
    let mut chronological = Vec::with_capacity(rows.len());
    for row in rows.into_iter().rev() {
        // hit_ratio is overwritten with the cross-step retention in pass 2 for
        // classified rows; for unclassifiable rows it stays this single-row
        // value (best available with no baseline).
        let total_prompt = row.input_tokens + row.cache_read + row.cache_write;
        let hit_ratio = if total_prompt > 0 {
            row.cache_read as f64 / total_prompt as f64
        } else {
            0.0
        };
        chronological.push(DbCacheEvent {
            harness: row.harness,
            message_id: row.message_id,
            session_id: row.session_id,
            timestamp: row.timestamp,
            input_tokens: row.input_tokens,
            cache_read: row.cache_read,
            cache_write: row.cache_write,
            total_tokens: row.total_tokens,
            hit_ratio,
            severity: String::new(),
            cause: None,
            agent: row.agent,
            finish: row.finish,
            turn_id: String::new(),
            is_turn_start: false,
            context_limit: row.context_limit.unwrap_or(0),
            context_limit_estimated: false, // set with context_limit below
            is_drop: false,                 // computed in pass 2
        });
    }

    // Inputs may arrive in any order; sort ascending so "previous" really means
    // "earlier in time" before computing turn IDs and cross-step retention.
    chronological.sort_by_key(|e| e.timestamp);

    // A session where NO row reports a positive cache_read doesn't expose cache
    // accounting at all (e.g. ollama-cloud reports cache_read=0 everywhere). We
    // can't judge its cache health, so every row is UNKNOWN, never a false bust.
    let mut session_has_cache: HashMap<(Harness, String), bool> = HashMap::new();
    for e in &chronological {
        let entry = session_has_cache
            .entry((e.harness, e.session_id.clone()))
            .or_insert(false);
        if e.cache_read > 0 {
            *entry = true;
        }
    }
    let session_keys: HashSet<(Harness, String)> = chronological
        .iter()
        .map(|e| (e.harness, e.session_id.clone()))
        .collect();
    let transform_decisions = transform_decisions_override.unwrap_or_else(|| {
        if enrich_causes {
            load_transform_decision_causes(&session_keys)
        } else {
            HashMap::new()
        }
    });
    let transform_failure_sessions = transform_failure_sessions_override.unwrap_or_else(|| {
        if enrich_causes {
            load_transform_failure_sessions(&session_keys)
        } else {
            HashSet::new()
        }
    });

    // ── Pass 2: turn grouping + cross-step retention severity ──
    // Expected next cache_read = prev.cache_read + growth, where growth is the
    // freshly-cacheable content the previous step contributed:
    //   - Anthropic reports it directly as cache_write (cache_creation tokens).
    //   - Other providers never report cache_write (always 0), so the previous
    //     step's own input + output is what becomes cached on the next step.
    //   growth = prev.cache_write > 0 ? prev.cache_write : prev.input + prev.output
    // retention = current.cache_read / expected (only when prev had a cache):
    //   >= 0.95 stable · 0.80..0.95 warning · < 0.80 bust · ==0 full_bust
    // (Verified empirically: on a stable step retention is 0.97-1.00+ across
    // anthropic/openai/etc.; real busts land < 0.4. Recovery steps grow exactly
    // as predicted, so they classify stable with no separate "warming" state.)
    let mut seen_sessions: HashSet<(Harness, String)> = HashSet::new();
    let mut last_finish_by_session: HashMap<(Harness, String), String> = HashMap::new();
    let mut current_turn_id_by_session: HashMap<(Harness, String), String> = HashMap::new();
    let mut prev_event_idx_by_session: HashMap<(Harness, String), usize> = HashMap::new();

    for i in 0..chronological.len() {
        let session_key = (
            chronological[i].harness,
            chronological[i].session_id.clone(),
        );

        // Turn grouping: a new turn starts at the session's first event or when
        // the previous event's finish != "tool-calls".
        let prev_finish = last_finish_by_session.get(&session_key).cloned();
        let is_new_turn = match prev_finish.as_deref() {
            None => true,
            Some("tool-calls") => false,
            Some(_) => true,
        };
        chronological[i].is_turn_start = is_new_turn;
        if is_new_turn {
            chronological[i].turn_id = chronological[i].message_id.clone();
            current_turn_id_by_session
                .insert(session_key.clone(), chronological[i].message_id.clone());
        } else {
            chronological[i].turn_id = current_turn_id_by_session
                .get(&session_key)
                .cloned()
                .unwrap_or_default();
        }

        // Severity.
        let is_first_in_window = seen_sessions.insert(session_key.clone());
        let uses_codex_no_write_model = chronological[i].harness.uses_codex_no_write_cache_model();
        let no_cache_session = !uses_codex_no_write_model
            && !session_has_cache
                .get(&session_key)
                .copied()
                .unwrap_or(false);
        let cur_read = chronological[i].cache_read;
        let cur_session = chronological[i].session_id.clone();
        let decision_key = (
            chronological[i].harness,
            cur_session.clone(),
            chronological[i].message_id.clone(),
        );
        let decision_row = transform_decisions.get(&decision_key);
        let has_transform_failure = transform_failure_sessions.contains(&session_key);
        // A missing decision is normal for routine passes that do not invalidate
        // the cache: the plugin persists decisions only when they bust the cache.
        // Attribute a transform failure only when a recorded error proves it;
        // otherwise report the cache loss as having an unknown origin.
        let cause_from_decision = || transform_decision_cause(decision_row);
        let cause_from_bust = || {
            cause_from_decision().or_else(|| {
                if has_transform_failure {
                    Some(MC_TRANSFORM_FAILED_OPEN_CAUSE.to_string())
                } else {
                    Some(UNATTRIBUTED_CACHE_BUST_CAUSE.to_string())
                }
            })
        };

        let (severity, cause, retention): (String, Option<String>, Option<f64>) =
            if no_cache_session {
                ("unknown".to_string(), None, None)
            } else if uses_codex_no_write_model {
                if is_first_in_window {
                    if true_first_sessions.contains(&session_key) {
                        (
                            "info".to_string(),
                            Some("First message (new session)".to_string()),
                            None,
                        )
                    } else {
                        ("stable".to_string(), None, None)
                    }
                } else {
                    // Codex/OpenAI implicit caching never reports cache writes.
                    // Its input token count includes the cached portion, so health
                    // is the current read share after normalizing input to the
                    // uncached remainder.
                    let prompt = chronological[i].cache_read + chronological[i].input_tokens;
                    if prompt <= 0 {
                        ("unknown".to_string(), None, None)
                    } else if cur_read == 0 {
                        ("full_bust".to_string(), None, Some(0.0))
                    } else {
                        let ret = cur_read as f64 / prompt as f64;
                        if ret >= 0.95 {
                            ("stable".to_string(), None, Some(ret))
                        } else if ret >= 0.80 {
                            ("warning".to_string(), None, Some(ret))
                        } else {
                            ("bust".to_string(), None, Some(ret))
                        }
                    }
                }
            } else if is_first_in_window {
                if true_first_sessions.contains(&session_key) {
                    (
                        "info".to_string(),
                        Some("First message (new session)".to_string()),
                        None,
                    )
                } else {
                    // No previous step in the loaded window → no baseline to compare
                    // against. Default benign rather than risk a false bust on the
                    // single edge row at the top of the window.
                    ("stable".to_string(), None, None)
                }
            } else if let Some(&prev_idx) = prev_event_idx_by_session.get(&session_key) {
                // Snapshot prev values out before mutating chronological[i].
                let (prev_read, prev_write, prev_input, prev_total) = {
                    let prev = &chronological[prev_idx];
                    (
                        prev.cache_read,
                        prev.cache_write,
                        prev.input_tokens,
                        prev.total_tokens,
                    )
                };
                if prev_read == 0 {
                    // No cache was established on the prior step (cold / still
                    // warming up), so a low/zero cache_read now isn't a LOSS.
                    ("stable".to_string(), None, None)
                } else {
                    let prev_output = (prev_total - prev_input - prev_read - prev_write).max(0);
                    let growth = if prev_write > 0 {
                        prev_write
                    } else {
                        prev_input + prev_output
                    };
                    let expected = prev_read + growth; // > 0 since prev_read > 0
                    if cur_read == 0 {
                        (
                            "full_bust".to_string(),
                            if enrich_causes {
                                cause_from_bust()
                            } else {
                                None
                            },
                            Some(0.0),
                        )
                    } else {
                        let ret = cur_read as f64 / expected as f64;
                        if ret >= 0.95 {
                            ("stable".to_string(), None, Some(ret))
                        } else if ret >= 0.80 {
                            (
                                "warning".to_string(),
                                if enrich_causes {
                                    transform_decision_cause(decision_row)
                                } else {
                                    None
                                },
                                Some(ret),
                            )
                        } else {
                            (
                                "bust".to_string(),
                                if enrich_causes {
                                    cause_from_bust()
                                } else {
                                    None
                                },
                                Some(ret),
                            )
                        }
                    }
                }
            } else {
                ("stable".to_string(), None, None)
            };

        // Drop detection: a meaningful prompt shrink vs the previous step means
        // MC reclaimed context this step. Mark it and (if not already) attach the
        // DB-recorded transform decision so the timeline explains WHY it dropped.
        let mut is_drop = false;
        let mut cause = cause;
        if let Some(&prev_idx) = prev_event_idx_by_session.get(&session_key) {
            let prev_prompt = {
                let prev = &chronological[prev_idx];
                prev.input_tokens + prev.cache_read + prev.cache_write
            };
            let cur_prompt = chronological[i].input_tokens
                + chronological[i].cache_read
                + chronological[i].cache_write;
            if prev_prompt - cur_prompt >= DROP_MARKER_MIN_TOKENS {
                is_drop = true;
                if cause.is_none() && enrich_causes {
                    cause = cause_from_decision();
                }
            }
        }

        chronological[i].severity = severity;
        chronological[i].cause = cause;
        chronological[i].is_drop = is_drop;
        if let Some(ret) = retention {
            // Display the cross-step RETENTION (cache held vs expected), not the
            // single-row prompt-composition ratio, so bars/percentages reflect
            // actual cache health.
            chronological[i].hit_ratio = ret;
        }

        prev_event_idx_by_session.insert(session_key.clone(), i);
        last_finish_by_session.insert(
            session_key,
            chronological[i].finish.clone().unwrap_or_default(),
        );
    }

    // ── Context-window scale: attach each session's context limit ──
    // Prefer a per-event JSONL limit (Codex reports the model context window
    // on token_count events), then the plugin's recorded limit, then the
    // session's own max prompt so the timeline still shows the sawtooth shape.
    let recorded_limits = resolve_session_context_limits(&session_keys);
    let mut max_prompt_by_session: HashMap<(Harness, String), i64> = HashMap::new();
    for e in &chronological {
        let prompt = e.input_tokens + e.cache_read + e.cache_write;
        let entry = max_prompt_by_session
            .entry((e.harness, e.session_id.clone()))
            .or_insert(0);
        if prompt > *entry {
            *entry = prompt;
        }
    }
    for e in &mut chronological {
        if e.context_limit > 0 {
            e.context_limit_estimated = false;
            continue;
        }
        let key = (e.harness, e.session_id.clone());
        let recorded = recorded_limits.get(&key).copied().filter(|&l| l > 0);
        match recorded {
            Some(limit) => {
                e.context_limit = limit;
                e.context_limit_estimated = false;
            }
            None => {
                // No recorded limit → max-prompt fallback. Mark it estimated so
                // the frontend collapses it to a stable per-session value (the
                // batch-local max climbs on the incremental fetch path).
                e.context_limit = max_prompt_by_session
                    .get(&key)
                    .copied()
                    .filter(|&m| m > 0)
                    .unwrap_or(0);
                e.context_limit_estimated = e.context_limit > 0;
            }
        }
    }

    chronological
}

pub fn get_cache_events_from_db(limit: usize, since_timestamp: Option<i64>) -> Vec<DbCacheEvent> {
    const MERGED_TIMELINE_LOOKBACK_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
    // This one-shot merged feed has no active dashboard caller. Keep its OpenCode
    // JSON extraction bounded so a future caller cannot accidentally scan years
    // of message history.
    let floor =
        since_timestamp.unwrap_or_else(|| now_millis().saturating_sub(MERGED_TIMELINE_LOOKBACK_MS));
    let mut rows = load_raw_db_cache_events(limit, Some(floor)).unwrap_or_default();
    rows.extend(load_raw_pi_cache_events(limit, Some(floor)));
    let (claude_rows, codex_rows) = load_raw_external_cache_events_parallel(limit, Some(floor));
    rows.extend(claude_rows);
    rows.extend(codex_rows);
    // Newest-first across all harnesses, then truncate to the same global cap
    // the OpenCode-only path used so the merged feed never balloons unbounded.
    rows.sort_by_key(|r| std::cmp::Reverse(r.timestamp));
    rows.truncate(limit.saturating_mul(10));
    build_db_cache_events(rows, true)
}

#[derive(Debug)]
struct CacheSessionListEntry {
    harness: Harness,
    session_id: String,
    last_activity_ms: i64,
    title: Option<String>,
}

const RECENT_OPENCODE_CACHE_SESSIONS_SQL: &str = "SELECT id, time_updated, NULLIF(title, '')
     FROM session
     WHERE time_archived IS NULL
     ORDER BY time_updated DESC, id DESC
     LIMIT ?1 OFFSET ?2";

const RECENT_OPENCODE_SESSION_MESSAGES_SQL: &str = "SELECT data
     FROM message
     WHERE session_id = ?1
     ORDER BY time_created DESC
     LIMIT ?2";

const FIRST_OPENCODE_CACHE_EVENT_SQL: &str = "SELECT time_created
     FROM message
     WHERE session_id = ?1
       AND json_extract(data, '$.role') = 'assistant'
       AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0
     ORDER BY time_created ASC
     LIMIT 1";

type OpenCodeCachePresenceCache = HashMap<String, (i64, bool)>;
static OPENCODE_CACHE_PRESENCE: OnceLock<RwLock<OpenCodeCachePresenceCache>> = OnceLock::new();

fn opencode_cache_presence() -> &'static RwLock<OpenCodeCachePresenceCache> {
    OPENCODE_CACHE_PRESENCE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn load_recent_opencode_cache_sessions(
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
) -> Vec<CacheSessionListEntry> {
    let Some(path) = resolve_opencode_db_path() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&path) else {
        return Vec::new();
    };
    if let Ok(mut cache) = opencode_cache_presence().write() {
        load_recent_opencode_cache_sessions_with_cache(
            &conn,
            limit,
            hidden_subagent_ids,
            &mut cache,
        )
    } else {
        load_recent_opencode_cache_sessions_from_conn(&conn, limit, hidden_subagent_ids)
    }
}

fn load_recent_opencode_cache_sessions_from_conn(
    conn: &Connection,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
) -> Vec<CacheSessionListEntry> {
    load_recent_opencode_cache_sessions_with_cache(
        conn,
        limit,
        hidden_subagent_ids,
        &mut HashMap::new(),
    )
}

fn load_recent_opencode_cache_sessions_with_cache(
    conn: &Connection,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
    presence_cache: &mut OpenCodeCachePresenceCache,
) -> Vec<CacheSessionListEntry> {
    const ABSOLUTE_MAX_SCANNED_SESSIONS: usize = 2_000;
    if limit == 0 {
        return Vec::new();
    }

    // One extra result budget after the first 4x page gets past a dense recent
    // run of eventless or hidden sessions. The floor gives small requests the
    // same protection without letting metadata polling grow unbounded.
    let max_scanned_sessions = limit
        .saturating_mul(5)
        .clamp(256, ABSOLUTE_MAX_SCANNED_SESSIONS);
    let batch_size = limit.saturating_mul(4).clamp(1, max_scanned_sessions);
    let Ok(mut candidates_stmt) = conn.prepare(RECENT_OPENCODE_CACHE_SESSIONS_SQL) else {
        return Vec::new();
    };
    let Ok(mut recent_messages_stmt) = conn.prepare(RECENT_OPENCODE_SESSION_MESSAGES_SQL) else {
        return Vec::new();
    };
    let Ok(mut event_stmt) = conn.prepare(FIRST_OPENCODE_CACHE_EVENT_SQL) else {
        return Vec::new();
    };
    let mut sessions = Vec::with_capacity(limit);
    let mut scanned = 0usize;

    while sessions.len() < limit && scanned < max_scanned_sessions {
        let page_limit = batch_size.min(max_scanned_sessions - scanned);
        let Ok(page_limit) = i64::try_from(page_limit) else {
            break;
        };
        let Ok(offset) = i64::try_from(scanned) else {
            break;
        };
        let page = {
            let Ok(rows) = candidates_stmt.query_map(params![page_limit, offset], |row| {
                Ok(CacheSessionListEntry {
                    harness: Harness::Opencode,
                    session_id: row.get(0)?,
                    last_activity_ms: row.get(1)?,
                    title: row.get(2)?,
                })
            }) else {
                break;
            };
            rows.flatten().collect::<Vec<_>>()
        };
        let page_len = page.len();
        scanned = scanned.saturating_add(page_len);

        for candidate in page {
            if hidden_subagent_ids.contains(&candidate.session_id) {
                continue;
            }
            let cached_presence = presence_cache
                .get(&candidate.session_id)
                .filter(|(time_updated, _)| *time_updated == candidate.last_activity_ms)
                .map(|(_, has_event)| *has_event);
            let has_event = cached_presence.unwrap_or_else(|| {
                // Most active sessions have a cache event in their newest rows.
                // Keep that fast path, then use the authoritative indexed probe
                // only when the bounded lookback misses.
                const CACHE_EVENT_LOOKBACK_MESSAGES: i64 = 200;
                let recent_has_event = recent_messages_stmt
                    .query_map(
                        params![&candidate.session_id, CACHE_EVENT_LOOKBACK_MESSAGES],
                        |row| row.get::<_, String>(0),
                    )
                    .ok()
                    .is_some_and(|rows| {
                        rows.flatten().any(|data| {
                            serde_json::from_str::<serde_json::Value>(&data)
                                .ok()
                                .is_some_and(|message| {
                                    message.get("role").and_then(serde_json::Value::as_str)
                                        == Some("assistant")
                                        && message
                                            .pointer("/tokens/total")
                                            .and_then(serde_json::Value::as_i64)
                                            .unwrap_or(0)
                                            > 0
                                })
                        })
                    });
                let has_event = recent_has_event
                    || event_stmt
                        .query_row(params![&candidate.session_id], |_| Ok(()))
                        .optional()
                        .ok()
                        .flatten()
                        .is_some();
                presence_cache.insert(
                    candidate.session_id.clone(),
                    (candidate.last_activity_ms, has_event),
                );
                has_event
            });
            if has_event {
                sessions.push(candidate);
                if sessions.len() == limit {
                    break;
                }
            }
        }
        if page_len < usize::try_from(page_limit).unwrap_or(usize::MAX) {
            break;
        }
    }

    sessions
}

fn resolve_store_db_path() -> Option<PathBuf> {
    let data_dir = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        });
    let path = data_dir
        .join("cortexkit")
        .join("magic-context")
        .join("store.db");
    path.exists().then_some(path)
}

fn load_managed_cache_sessions(keys: &HashSet<(Harness, String)>) -> HashSet<(Harness, String)> {
    let Some(path) = resolve_store_db_path() else {
        return HashSet::new();
    };
    load_managed_cache_sessions_from_path(&path, keys)
}

fn load_managed_cache_sessions_from_path(
    path: &Path,
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    let Ok(conn) = open_readonly(&path.to_path_buf()) else {
        return HashSet::new();
    };
    load_managed_cache_sessions_from_conn(&conn, keys)
}

fn load_managed_cache_sessions_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    let external_session_ids: Vec<String> = keys
        .iter()
        .filter(|(harness, _)| matches!(harness, Harness::ClaudeCode | Harness::Codex))
        .map(|(_, session_id)| session_id.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if external_session_ids.is_empty() || !table_exists(conn, "mc_cache_state") {
        return HashSet::new();
    }

    let values = vec!["(?)"; external_session_ids.len()].join(",");
    let sql = format!(
        "WITH wanted(session_id) AS (VALUES {values})
         SELECT DISTINCT w.session_id
         FROM wanted w
         JOIN mc_cache_state m
           ON m.session_id = w.session_id
           OR (m.session_id >= (w.session_id || char(0x241F))
               AND m.session_id < (w.session_id || char(0x2420)))"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return HashSet::new();
    };
    let rows = stmt.query_map(params_from_iter(external_session_ids.iter()), |row| {
        row.get::<_, String>(0)
    });
    let Ok(rows) = rows else {
        return HashSet::new();
    };
    let managed_ids: HashSet<String> = rows.flatten().collect();
    keys.iter()
        .filter(|(harness, session_id)| {
            matches!(harness, Harness::ClaudeCode | Harness::Codex)
                && managed_ids.contains(session_id)
        })
        .cloned()
        .collect()
}

fn is_managed_cache_session(
    harness: Harness,
    session_id: &str,
    detected: &HashSet<(Harness, String)>,
) -> bool {
    harness.has_magic_context_plugin_state()
        || detected.contains(&(harness, session_id.to_string()))
}

pub fn load_cache_session_titles(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), String> {
    let mut titles = HashMap::new();
    let opencode_ids: Vec<String> = keys
        .iter()
        .filter(|(harness, _)| *harness == Harness::Opencode)
        .map(|(_, sid)| sid.clone())
        .collect();
    if !opencode_ids.is_empty() {
        if let Some(path) = resolve_opencode_db_path() {
            if let Ok(conn) = open_readonly(&path) {
                let placeholders = vec!["?"; opencode_ids.len()].join(",");
                let sql = format!(
                    "SELECT id, COALESCE(title, '') FROM session WHERE id IN ({placeholders})"
                );
                if let Ok(mut stmt) = conn.prepare(&sql) {
                    if let Ok(rows) = stmt.query_map(params_from_iter(opencode_ids.iter()), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    }) {
                        for (sid, title) in rows.flatten() {
                            if !title.is_empty() {
                                titles.insert((Harness::Opencode, sid), title);
                            }
                        }
                    }
                }
            }
        }
    }

    for meta in pi_sessions::scan_pi_compatible_session_dir() {
        let key = (Harness::Pi, meta.session_id.clone());
        if keys.contains(&key) {
            titles.insert(key, clean_pi_title(meta.session_name, &meta.first_message));
        }
    }
    for meta in external_cache_sessions::scan_claude_code_session_dir() {
        let key = (Harness::ClaudeCode, meta.session_id.clone());
        if keys.contains(&key) {
            titles.insert(key, basename(&meta.cwd));
        }
    }
    for meta in external_cache_sessions::scan_codex_session_dir() {
        let key = (Harness::Codex, meta.session_id.clone());
        if keys.contains(&key) {
            titles.insert(key, basename(&meta.cwd));
        }
    }

    titles
}

pub fn load_cache_subagent_flags(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), bool> {
    let mut out = HashMap::new();
    for harness in [Harness::Opencode, Harness::Pi] {
        if keys.iter().any(|(h, _)| *h == harness) {
            for (session_id, is_subagent) in load_subagent_map_for_harness(harness) {
                let key = (harness, session_id);
                if keys.contains(&key) {
                    out.insert(key, is_subagent);
                }
            }
        }
    }
    out
}

pub fn get_session_cache_stats_from_db(
    limit: usize,
    show_unmanaged: bool,
    hide_subagents: bool,
    harness_filter: Option<Harness>,
) -> Vec<SessionCacheStats> {
    // The list endpoint carries only metadata. Cache totals are derived from the
    // same bounded per-session windows that the frontend already loads for the
    // cards and chart, so the 1s reconcile never recomputes global aggregates.
    let mut pre_cap_subagent_flags = HashMap::new();
    if hide_subagents {
        for harness in [Harness::Opencode, Harness::Pi] {
            if harness_filter.map_or(true, |filter| filter == harness) {
                pre_cap_subagent_flags.extend(
                    load_subagent_map_for_harness(harness)
                        .into_iter()
                        .map(|(session_id, is_subagent)| ((harness, session_id), is_subagent)),
                );
            }
        }
    }
    let hidden_opencode_ids: HashSet<String> = pre_cap_subagent_flags
        .iter()
        .filter(|((harness, _), is_subagent)| *harness == Harness::Opencode && **is_subagent)
        .map(|((_, session_id), _)| session_id.clone())
        .collect();
    let includes_harness = |harness| harness_filter.map_or(true, |filter| filter == harness);

    let (mut sessions, pi_sessions, claude_sessions, codex_sessions) =
        std::thread::scope(|scope| {
            let opencode = scope.spawn(|| {
                if includes_harness(Harness::Opencode) {
                    load_recent_opencode_cache_sessions(limit, &hidden_opencode_ids)
                } else {
                    Vec::new()
                }
            });
            let pi = scope.spawn(|| {
                if includes_harness(Harness::Pi) {
                    pi_sessions::scan_pi_compatible_cache_session_dir()
                } else {
                    Vec::new()
                }
            });
            let claude = scope.spawn(|| {
                if includes_harness(Harness::ClaudeCode) {
                    external_cache_sessions::scan_claude_code_session_dir()
                } else {
                    Vec::new()
                }
            });
            let codex = scope.spawn(|| {
                if includes_harness(Harness::Codex) {
                    external_cache_sessions::scan_codex_session_dir()
                } else {
                    Vec::new()
                }
            });
            (
                opencode.join().unwrap_or_default(),
                pi.join().unwrap_or_default(),
                claude.join().unwrap_or_default(),
                codex.join().unwrap_or_default(),
            )
        });
    sessions.extend(pi_sessions.into_iter().map(|meta| CacheSessionListEntry {
        harness: Harness::Pi,
        session_id: meta.session_id,
        last_activity_ms: meta.modified,
        title: Some(clean_pi_title(meta.session_name, &meta.first_message)),
    }));
    sessions.extend(
        claude_sessions
            .into_iter()
            .map(|meta| CacheSessionListEntry {
                harness: Harness::ClaudeCode,
                session_id: meta.session_id,
                last_activity_ms: meta.modified,
                title: Some(basename(&meta.cwd)),
            }),
    );
    sessions.extend(
        codex_sessions
            .into_iter()
            .map(|meta| CacheSessionListEntry {
                harness: Harness::Codex,
                session_id: meta.session_id,
                last_activity_ms: meta.modified,
                title: Some(basename(&meta.cwd)),
            }),
    );

    let candidate_keys: HashSet<(Harness, String)> = sessions
        .iter()
        .map(|row| (row.harness, row.session_id.clone()))
        .collect();
    let detected_managed = load_managed_cache_sessions(&candidate_keys);
    if !show_unmanaged {
        sessions.retain(|row| {
            is_managed_cache_session(row.harness, &row.session_id, &detected_managed)
        });
    }
    if hide_subagents {
        sessions.retain(|row| {
            !pre_cap_subagent_flags
                .get(&(row.harness, row.session_id.clone()))
                .copied()
                .unwrap_or(false)
        });
    }
    sessions.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    sessions.truncate(limit);

    let stat_keys: HashSet<(Harness, String)> = sessions
        .iter()
        .map(|row| (row.harness, row.session_id.clone()))
        .collect();
    let subagent_flags = if hide_subagents {
        pre_cap_subagent_flags
    } else {
        load_cache_subagent_flags(&stat_keys)
    };

    sessions
        .into_iter()
        .map(|row| {
            let key = (row.harness, row.session_id.clone());
            SessionCacheStats {
                harness: row.harness,
                session_id: row.session_id,
                event_count: 0,
                total_cache_read: 0,
                total_cache_write: 0,
                total_input: 0,
                hit_ratio: 0.0,
                last_timestamp: format_timestamp_iso(row.last_activity_ms),
                last_activity_ms: row.last_activity_ms,
                bust_count: 0,
                managed: is_managed_cache_session(row.harness, &key.1, &detected_managed),
                is_subagent: subagent_flags.get(&key).copied().unwrap_or(false),
                title: row.title,
            }
        })
        .collect()
}

// `limit` caps the returned event count to the most recent N (newest-first
// selection from the DB, then re-sorted to chronological for the chart).
// Passing 0 or a huge value effectively returns the whole session — keep
// the dashboard's PER_SESSION = 200 budget in mind on call sites that go
// straight into a chart, because every event is ~250 bytes of JSON across
// the Tauri IPC boundary and a hot session can produce 30k+ events.
/// `since_timestamp`: when Some, return that session's events with
/// `time_created >= since` in chronological order (used by the dashboard's
/// incremental 1s poll — fetch only what's new). The `>=` (not `>`) is
/// deliberate: it re-includes the caller's last-seen event as a 1-event overlap
/// so `build_db_cache_events` can compute the first NEW event's cross-step
/// severity against a real predecessor; the frontend dedupes the overlap by
/// `message_id`. When None, return the most-recent `limit` events (initial /
/// full-window load).
pub fn get_session_cache_events(
    harness: Harness,
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    match harness {
        Harness::Opencode => get_opencode_session_cache_events(session_id, limit, since_timestamp),
        Harness::Pi => get_pi_session_cache_events(session_id, limit, since_timestamp),
        Harness::ClaudeCode => {
            get_claude_code_session_cache_events(session_id, limit, since_timestamp)
        }
        Harness::Codex => get_codex_session_cache_events(session_id, limit, since_timestamp),
    }
}

/// Trim a chronologically-ordered event list to at most `target_turns`
/// complete turns, keeping the most recent turns.
fn trim_events_to_turns(events: Vec<DbCacheEvent>, target_turns: usize) -> Vec<DbCacheEvent> {
    if events.is_empty() || target_turns == 0 {
        return Vec::new();
    }
    let turn_starts: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| e.is_turn_start)
        .map(|(i, _)| i)
        .collect();
    if turn_starts.len() <= target_turns {
        return events;
    }
    let keep_from_idx = turn_starts[turn_starts.len() - target_turns];
    events.into_iter().skip(keep_from_idx).collect()
}

/// Fetch events for one session, trimmed so the result contains at most
/// `target_turns` complete turns (most recent first). Events are returned
/// in chronological order (oldest → newest).
///
/// Strategy: fetch up to `max_events = target_turns * 50` raw events (cap of 50
/// events/turn is conservative — even very heavy tool-use turns rarely exceed
/// that). Then group into turns. If we got more than target_turns, drop oldest
/// events until only `target_turns` most-recent turns remain.
pub fn get_session_cache_events_by_turn_count(
    harness: Harness,
    session_id: &str,
    target_turns: usize,
) -> Vec<DbCacheEvent> {
    let max_events = (target_turns * 50).max(200); // floor to existing limit
    let raw = match harness {
        Harness::Opencode => get_opencode_session_cache_events(session_id, Some(max_events), None),
        Harness::Pi => get_pi_session_cache_events(session_id, Some(max_events), None),
        Harness::ClaudeCode => {
            get_claude_code_session_cache_events(session_id, Some(max_events), None)
        }
        Harness::Codex => get_codex_session_cache_events(session_id, Some(max_events), None),
    };
    trim_events_to_turns(raw, target_turns)
}

fn get_opencode_session_cache_events(
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&opencode_db_path) else {
        return Vec::new();
    };

    const COLS: &str = "SELECT CAST(id AS TEXT), session_id, time_created,
                COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0),
                CAST(json_extract(data, '$.agent') AS TEXT),
                CAST(json_extract(data, '$.finish') AS TEXT)
         FROM message
         WHERE session_id = ?1
           AND json_extract(data, '$.role') = 'assistant'
           AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0";

    // Incremental (since): everything at/after the anchor, chronological. No
    // LIMIT — a 1s poll's delta is tiny, and the >= overlap is a single row.
    // Full (no since): the most-recent `limit`, DESC + LIMIT; build_db_cache_events
    // re-sorts ASC to chronological.
    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match since_timestamp {
        Some(since) => (
            format!("{COLS} AND time_created >= ?2 ORDER BY time_created ASC"),
            vec![
                Box::new(session_id.to_string()) as Box<dyn rusqlite::types::ToSql>,
                Box::new(since),
            ],
        ),
        None => {
            let lim: i64 = match limit {
                Some(n) if n > 0 => n as i64,
                _ => -1, // SQLite: negative LIMIT == no limit.
            };
            (
                format!("{COLS} ORDER BY time_created DESC LIMIT ?2"),
                vec![
                    Box::new(session_id.to_string()) as Box<dyn rusqlite::types::ToSql>,
                    Box::new(lim),
                ],
            )
        }
    };

    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let Ok(rows) = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(RawDbCacheEvent {
            harness: Harness::Opencode,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
            context_limit: None,
        })
    }) else {
        return Vec::new();
    };
    build_db_cache_events(rows.flatten().collect(), true)
}

fn get_pi_session_cache_events(
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    let Some(path) = pi_sessions::find_pi_session_path(session_id) else {
        return Vec::new();
    };
    let Some(detail) = pi_sessions::read_pi_session_detail(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<RawDbCacheEvent> = detail
        .messages
        .into_iter()
        .filter(|message| message.role == "assistant")
        .filter_map(|message| {
            let usage = message.usage?;
            (usage.total > 0).then_some(RawDbCacheEvent {
                harness: Harness::Pi,
                message_id: message.entry_id,
                session_id: session_id.to_string(),
                timestamp: message.timestamp_ms,
                input_tokens: usage.input as i64,
                cache_read: usage.cache_read as i64,
                cache_write: usage.cache_write as i64,
                total_tokens: usage.total as i64,
                agent: None,
                finish: message.stop_reason,
                context_limit: None,
            })
        })
        .collect();
    match since_timestamp {
        // Incremental: keep events at/after the anchor (>= for the 1-event
        // severity overlap), already chronological from the JSONL order.
        Some(since) => rows.retain(|r| r.timestamp >= since),
        // Full: tail-truncate to the most-recent N (JSONL is chronological, so
        // the last N are the freshest).
        None => {
            if let Some(n) = limit {
                if n > 0 && rows.len() > n {
                    let start = rows.len() - n;
                    rows.drain(..start);
                }
            }
        }
    }
    build_db_cache_events(rows, false)
}

fn get_claude_code_session_cache_events(
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    let Some(meta) = external_cache_sessions::find_claude_code_session_meta(session_id) else {
        return Vec::new();
    };
    get_external_session_cache_events(
        Harness::ClaudeCode,
        session_id,
        &meta,
        external_cache_sessions::read_claude_code_session_detail,
        limit,
        since_timestamp,
    )
}

fn get_codex_session_cache_events(
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    let Some(meta) = external_cache_sessions::find_codex_session_meta(session_id) else {
        return Vec::new();
    };
    get_external_session_cache_events(
        Harness::Codex,
        session_id,
        &meta,
        external_cache_sessions::read_codex_session_detail,
        limit,
        since_timestamp,
    )
}

fn get_external_session_cache_events(
    harness: Harness,
    session_id: &str,
    meta: &external_cache_sessions::JsonlSessionMeta,
    read_detail: fn(&Path) -> Option<Arc<external_cache_sessions::JsonlSessionDetail>>,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    if since_timestamp.is_some_and(|since| {
        external_cache_sessions::source_file_mtime_is_not_newer_than(meta, since)
    }) {
        return Vec::new();
    }
    let Some(detail) = read_detail(&meta.jsonl_path) else {
        return Vec::new();
    };
    let mut rows: Vec<RawDbCacheEvent> = detail
        .events
        .iter()
        .map(|event| RawDbCacheEvent {
            harness,
            message_id: event.message_id.clone(),
            session_id: session_id.to_string(),
            timestamp: event.timestamp_ms,
            input_tokens: event.input_tokens,
            cache_read: event.cache_read,
            cache_write: event.cache_write,
            total_tokens: event.total_tokens,
            agent: event.model.clone(),
            finish: event.finish.clone(),
            context_limit: event.context_limit,
        })
        .collect();
    match since_timestamp {
        // Incremental: keep events at/after the anchor (>= for the 1-event
        // severity overlap), already chronological from the JSONL order.
        Some(since) => rows.retain(|r| r.timestamp >= since),
        None => {
            if let Some(n) = limit {
                if n > 0 && rows.len() > n {
                    let start = rows.len() - n;
                    rows.drain(..start);
                }
            }
        }
    }
    build_db_cache_events(rows, false)
}

// ── Project resolution ────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ProjectInfo {
    pub identity: String,
    pub label: String,        // friendly name (directory basename or identity)
    pub path: Option<String>, // resolved filesystem path, if found
}

pub fn get_projects(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let workspace_identities =
        crate::workspaces::extra_workspace_member_identities(conn).unwrap_or_default();

    // UNION only the project-path sources that exist. The dashboard opens the
    // DB read-only and never migrates, so a DB older than the Dreamer V2 schema
    // lacks task_schedule_state / dream_runs; an unconditional UNION would throw
    // "no such table" and break the Projects page instead of degrading.
    let mut sources = vec!["SELECT project_path FROM memories".to_string()];
    if table_exists(conn, "task_schedule_state") {
        sources.push("SELECT project_path FROM task_schedule_state".to_string());
    }
    if table_exists(conn, "dream_runs") {
        sources.push("SELECT project_path FROM dream_runs".to_string());
    }
    let union_sql = format!(
        "{} ORDER BY project_path",
        sources.join("\n         UNION\n         ")
    );
    let mut stmt = conn.prepare(&union_sql)?;
    let stored_values: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut identity_set: HashSet<String> = stored_values
        .into_iter()
        .map(|value| normalize_stored_project_path(&value))
        .filter(|identity| !identity.is_empty())
        .collect();
    identity_set.extend(workspace_identities);
    let mut identities: Vec<String> = identity_set.into_iter().collect();
    identities.sort();

    // Use the same enumeration as the project list shown to the user. It keys on
    // recorded project identities instead of comparing against OpenCode's own
    // project identifier.
    let identity_to_row: HashMap<String, ProjectRow> = enumerate_projects_filtered(None)
        .into_iter()
        .map(|row| (row.identity.clone(), row))
        .collect();

    let projects = identities
        .into_iter()
        .map(|id| {
            let (label, path) = if let Some(row) = identity_to_row.get(&id) {
                (row.display_name.clone(), Some(row.primary_path.clone()))
            } else if id.starts_with("git:") {
                let short = &id[4..std::cmp::min(id.len(), 14)];
                (format!("git:{short}…"), None)
            } else {
                (id.clone(), None)
            };
            ProjectInfo {
                identity: id,
                label,
                path,
            }
        })
        .collect();

    Ok(projects)
}

pub fn enumerate_projects() -> Vec<ProjectRow> {
    enumerate_projects_filtered(None)
}

pub fn enumerate_memory_projects(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT project_path
         FROM memories
         WHERE status = 'active'
         ORDER BY project_path",
    )?;
    let memory_project_values: HashSet<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<HashSet<_>, _>>()?;

    // Memory rows usually store a resolved project identity (`git:<hash>` or
    // `dir:<md5-12>`). Some old rows may still store a raw filesystem path.
    // Normalize both shapes so the picker is keyed by identity rather than by
    // whatever path string happened to be written originally.
    let memory_identities: HashSet<String> = memory_project_values
        .iter()
        .map(|value| normalize_stored_project_path(value))
        .collect();

    let mut picker_identities = memory_identities;
    if let Ok(extra) = crate::workspaces::extra_workspace_member_identities(conn) {
        picker_identities.extend(extra);
    }

    let mut all = enumerate_projects_filtered(None);
    let mut known: HashSet<String> = all.iter().map(|r| r.identity.clone()).collect();
    if let Ok(rows) = crate::workspaces::workspace_member_picker_rows(conn) {
        for row in rows {
            if picker_identities.contains(&row.identity) && !known.contains(&row.identity) {
                known.insert(row.identity.clone());
                all.push(row);
            }
        }
    }
    for identity in &picker_identities {
        if !known.contains(identity) {
            let display_name = if identity.starts_with("git:") {
                let short = &identity[4..std::cmp::min(identity.len(), 14)];
                format!("git:{short}…")
            } else if identity.starts_with("dir:") {
                let short = &identity[4..std::cmp::min(identity.len(), 14)];
                format!("dir:{short}…")
            } else {
                basename(identity)
            };
            all.push(ProjectRow {
                identity: identity.clone(),
                display_name,
                primary_path: "".to_string(),
                harnesses: vec![],
                session_count: 0,
            });
        }
    }
    all.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(all
        .into_iter()
        .filter(|row| picker_identities.contains(&row.identity))
        .collect())
}

/// Return `(identity, directory)` pairs for sessions whose identity was recorded
/// in the session identity map. Missing rows are normal for sessions from before
/// identity tracking was added; those sessions cannot safely contribute a
/// project identity here.
fn mapped_session_directories(identities: &SessionIdentityMap) -> Vec<(String, String)> {
    let mut dirs = Vec::new();

    if let Some(oc) = resolve_opencode_db_path() {
        if let Ok(conn) = open_readonly(&oc) {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT id, COALESCE(directory, '')
                 FROM session
                 WHERE directory IS NOT NULL AND directory != ''",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }) {
                    for row in rows.flatten() {
                        let (session_id, dir) = row;
                        let identity =
                            lookup_session_identity(identities, Harness::Opencode, &session_id);
                        if !identity.is_empty() {
                            dirs.push((identity, dir));
                        }
                    }
                }
            }
        }
    }

    for meta in pi_sessions::scan_pi_compatible_session_dir() {
        if meta.cwd.is_empty() {
            continue;
        }
        let identity = lookup_session_identity(identities, Harness::Pi, &meta.session_id);
        if !identity.is_empty() {
            dirs.push((identity, meta.cwd));
        }
    }

    dirs
}

fn session_identity_by_directory(identities: &SessionIdentityMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for (identity, dir) in mapped_session_directories(identities) {
        map.entry(dir).or_insert(identity);
    }
    map
}

/// Map project identity to a representative real directory using only the session
/// identities recorded in the session identity map. Sessions without a recorded
/// identity are omitted because there is no authoritative project identity to
/// group them under.
fn session_directories_by_identity() -> HashMap<String, String> {
    let identities = load_session_identity_map();
    let mut map: HashMap<String, String> = HashMap::new();
    for (identity, dir) in mapped_session_directories(&identities) {
        map.entry(identity)
            .and_modify(|existing| {
                if dir_is_better_representative(&dir, existing) {
                    *existing = dir.clone();
                }
            })
            .or_insert(dir);
    }
    map
}

/// True if `candidate` is a better representative directory for a project than
/// `current`. A git WORKTREE shares its main repo's root-commit identity, so
/// several directories can map to one `git:` identity — but the MAIN checkout
/// is the one a user recognizes (and names the project after). A main checkout
/// has `.git` as a directory; a worktree has `.git` as a FILE pointing into the
/// main repo's `.git/worktrees/`. Prefer a main checkout over a worktree; within
/// the same kind, prefer the shorter path (closest to the repo root). Without
/// this, a recent Alfonso/mason worktree (`bg_<hash>`) would win the label and
/// the project would show as `bg_<hash>` instead of e.g. `aft`.
fn dir_is_better_representative(candidate: &str, current: &str) -> bool {
    let cand_main = path_is_main_checkout(candidate);
    let cur_main = path_is_main_checkout(current);
    match (cand_main, cur_main) {
        (true, false) => true,
        (false, true) => false,
        _ => candidate.len() < current.len(),
    }
}

/// A main checkout has `.git` as a directory; a worktree has `.git` as a file.
fn path_is_main_checkout(dir: &str) -> bool {
    std::path::Path::new(dir).join(".git").is_dir()
}

fn enumerate_projects_filtered(project_paths_filter: Option<&HashSet<String>>) -> Vec<ProjectRow> {
    #[derive(Default)]
    struct ProjectAccum {
        opencode_name: Option<String>,
        opencode_path: Option<String>,
        pi_path: Option<String>,
        harnesses: HashSet<Harness>,
        session_count: u32,
    }

    let mut groups: HashMap<String, ProjectAccum> = HashMap::new();
    let session_identities = load_session_identity_map();
    let identity_by_dir = session_identity_by_directory(&session_identities);

    if let Some(opencode_db_path) = resolve_opencode_db_path() {
        if let Ok(conn) = open_readonly(&opencode_db_path) {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT p.name, p.worktree, COUNT(s.id)
                 FROM project p LEFT JOIN session s ON s.project_id = p.id
                 GROUP BY p.id, p.name, p.worktree",
            ) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                }) {
                    for (name, worktree, count) in rows.flatten() {
                        if let Some(allowed_paths) = project_paths_filter {
                            if !allowed_paths.contains(&worktree) {
                                continue;
                            }
                        }
                        let Some(identity) = identity_by_dir.get(&worktree).cloned() else {
                            continue;
                        };
                        let entry = groups.entry(identity).or_default();
                        if !name.is_empty() {
                            entry.opencode_name = Some(name);
                        }
                        entry.opencode_path = Some(worktree);
                        entry.harnesses.insert(Harness::Opencode);
                        entry.session_count =
                            entry.session_count.saturating_add(count.max(0) as u32);
                    }
                }
            }
        }
    }

    let mut pi_counts: HashMap<String, (String, u32)> = HashMap::new();
    for meta in pi_sessions::scan_pi_compatible_session_dir() {
        if let Some(allowed_paths) = project_paths_filter {
            if !allowed_paths.contains(&meta.cwd) {
                continue;
            }
        }
        let identity = lookup_session_identity(&session_identities, Harness::Pi, &meta.session_id);
        if identity.is_empty() {
            continue;
        }
        let entry = pi_counts.entry(identity).or_insert((meta.cwd, 0));
        entry.1 = entry.1.saturating_add(1);
    }
    if let Some(allowed_paths) = project_paths_filter {
        for project_path in allowed_paths {
            let Some(identity) = identity_by_dir.get(project_path).cloned() else {
                continue;
            };
            groups.entry(identity).or_insert_with(|| ProjectAccum {
                opencode_path: Some(project_path.clone()),
                ..ProjectAccum::default()
            });
        }
    }

    for (identity, (cwd, count)) in pi_counts {
        let entry = groups.entry(identity).or_default();
        entry.pi_path = Some(cwd);
        entry.harnesses.insert(Harness::Pi);
        entry.session_count = entry.session_count.saturating_add(count);
    }

    let mut rows: Vec<ProjectRow> = groups
        .into_iter()
        .map(|(identity, group)| {
            let primary_path = group
                .opencode_path
                .clone()
                .or(group.pi_path.clone())
                .unwrap_or_default();
            let display_name = group
                .opencode_name
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| basename(&primary_path));
            let mut harnesses: Vec<Harness> = group.harnesses.into_iter().collect();
            harnesses.sort();
            ProjectRow {
                identity,
                display_name,
                primary_path,
                harnesses,
                session_count: group.session_count,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    rows
}

/// Build the Projects card grid. One pass over the session truth
/// (`list_all_sessions`, both harnesses) grouped by project identity, enriched
/// per group with its active-memory count and workspace name. Primary sessions
/// only count toward `session_count`/`last_activity_ms` (subagents are an
/// implementation detail, not a project the user navigates), but a project that
/// has ONLY subagent sessions still appears (so nothing silently vanishes).
///
/// `conn` is the context.db handle (memories + workspaces). Returns cards sorted
/// by last activity, newest first.
pub fn get_project_cards(conn: &Connection) -> Vec<ProjectCard> {
    #[derive(Default)]
    struct Accum {
        display_name: String,
        harnesses: HashSet<Harness>,
        primary_sessions: u32,
        last_activity_ms: i64,
    }

    let mut groups: HashMap<String, Accum> = HashMap::new();
    for row in list_all_sessions(SessionFilter::default()) {
        if row.project_identity.is_empty() {
            continue;
        }
        let entry = groups.entry(row.project_identity.clone()).or_default();
        entry.harnesses.insert(row.harness);
        // First time we see a usable display name / path for this identity, keep
        // it (rows are newest-first, so the freshest label wins).
        if entry.display_name.is_empty()
            && !row.project_display.is_empty()
            && row.project_display != "/"
        {
            entry.display_name = row.project_display.clone();
        }
        if !row.is_subagent {
            entry.primary_sessions = entry.primary_sessions.saturating_add(1);
            if row.last_activity_ms > entry.last_activity_ms {
                entry.last_activity_ms = row.last_activity_ms;
            }
        } else if entry.last_activity_ms == 0 && row.last_activity_ms > 0 {
            // Subagent-only project: still surface a last-activity so it sorts.
            entry.last_activity_ms = row.last_activity_ms;
        }
    }

    // Workspace membership: project identity → workspace name (members ≤ 1 ws).
    let workspace_by_identity = workspace_name_by_identity(conn);
    // identity → representative real directory (resolves dir:<hash> to its cwd).
    let dir_by_identity = session_directories_by_identity();

    let mut cards: Vec<ProjectCard> = groups
        .into_iter()
        .map(|(identity, accum)| {
            let memory_count = count_memories_matching_identity(conn, &identity).unwrap_or(0);
            let primary_path = dir_by_identity.get(&identity).cloned().unwrap_or_default();
            // Prefer the representative directory's basename for the label: it's
            // resolved to the MAIN checkout (not a worktree), so a project shows as
            // e.g. `aft` rather than a recent worktree's `bg_<hash>` session label.
            // Fall back to the session-derived label, then a short identity.
            let display_name = if !primary_path.is_empty() {
                basename(&primary_path)
            } else if !accum.display_name.is_empty() {
                accum.display_name
            } else {
                short_identity_label(&identity)
            };
            let mut harnesses: Vec<Harness> = accum.harnesses.into_iter().collect();
            harnesses.sort();
            ProjectCard {
                workspace_name: workspace_by_identity.get(&identity).cloned(),
                identity,
                display_name,
                primary_path,
                harnesses,
                session_count: accum.primary_sessions,
                memory_count,
                last_activity_ms: accum.last_activity_ms,
            }
        })
        // Drop ephemeral noise. Two cases:
        //   1. Deleted worktrees with no surviving primary session and no memory
        //      (orphan subagent rows under a `dir:<hash>` fallback identity).
        //   2. Deleted mason/background worktrees (`bg_<hash>`) that DID own a
        //      primary session: a LIVE worktree coalesces into its git root, so a
        //      card that still resolves to `dir:<hash>` with its own basename means
        //      the worktree was removed and its directory no longer exists on disk.
        // Keep anything with memories (real curated knowledge, even if the dir
        // moved); for memory-less cards, require the representative directory to
        // still exist. An empty path can't be verified, so keep it conservatively.
        .filter(|card| {
            if card.memory_count > 0 {
                return true;
            }
            if card.session_count == 0 {
                return false;
            }
            if card.primary_path.is_empty() {
                return true;
            }
            std::path::Path::new(&card.primary_path).exists()
        })
        .collect();
    cards.sort_by_key(|card| std::cmp::Reverse(card.last_activity_ms));
    cards
}

/// A short, human-ish label for an identity that has no resolved directory name
/// (e.g. a `git:<hash>` whose worktree is gone). Mirrors `enumerate_memory_projects`.
fn short_identity_label(identity: &str) -> String {
    if let Some(rest) = identity.strip_prefix("git:") {
        format!("git:{}…", &rest[..std::cmp::min(rest.len(), 10)])
    } else if let Some(rest) = identity.strip_prefix("dir:") {
        format!("dir:{}…", &rest[..std::cmp::min(rest.len(), 10)])
    } else {
        basename(identity)
    }
}

/// Map each project identity that is a workspace member to its workspace name.
/// Empty (no allocation beyond the map) when the workspace schema isn't present.
fn workspace_name_by_identity(conn: &Connection) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(workspaces) = crate::workspaces::list_workspaces(conn) else {
        return map;
    };
    for ws in workspaces {
        for member in ws.members {
            map.insert(member.project_path, ws.name.clone());
        }
    }
    map
}

// ── Query implementations ─────────────────────────────────────

/// Presence flag for list queries: at least one row in `memory_embeddings` for this
/// memory. Uses EXISTS instead of LEFT JOIN so a memory with multiple model-specific
/// embedding rows still appears once in the result set.
const HAS_EMBEDDING_SELECT: &str =
    "(EXISTS (SELECT 1 FROM memory_embeddings me WHERE me.memory_id = m.id)) AS has_embedding";

/// Resolve a project filter value (an identity like `git:<hash>` / `dir:<sha>`,
/// or a legacy raw filesystem path) into the set of `memories.project_path`
/// values that should be matched against.
///
/// When a project identity is stored directly, which is the common case, it
/// matches exactly. Older rows that still contain raw filesystem paths are
/// normalized with the deterministic directory fallback; this keeps historical
/// non-git rows queryable without probing the filesystem or spawning external
/// tools.
///
/// If nothing normalizes to the filter, treat the filter as an old raw path and
/// query that literal value so external callers keep the pre-identity behavior.
pub(crate) fn resolve_paths_for_memory_filter(
    conn: &Connection,
    project_filter: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    resolve_paths_for_table_filter(conn, "memories", project_filter)
}

/// Count the ACTIVE (active + permanent) memories whose stored `project_path`
/// normalizes to `member_identity`. Archived/superseded rows are excluded — the
/// project card and workspace member count both want the live, injectable pool
/// (matching the Memories tab's "N active" headline), not the full historical
/// table (which is dominated by archived rows after curation).
pub fn count_memories_matching_identity(
    conn: &Connection,
    member_identity: &str,
) -> Result<i64, rusqlite::Error> {
    let paths = resolve_paths_for_memory_filter(conn, member_identity)?;
    if paths.is_empty() {
        return Ok(0);
    }
    let placeholders = build_in_placeholders(paths.len(), 1);
    let sql = format!(
        "SELECT COUNT(*) FROM memories
         WHERE status IN ('active', 'permanent') AND project_path IN ({})",
        placeholders
    );
    conn.query_row(&sql, rusqlite::params_from_iter(paths.iter()), |r| r.get(0))
}

pub(crate) fn bump_project_memory_epoch_for_identity_pub(
    tx: &Transaction<'_>,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    bump_project_memory_epoch_for_identity(tx, identity)
}

/// Resolve a project-identity filter (`git:<sha>` / `dir:<hash>`) to the stored
/// `project_path` values in `table` that normalize to the same identity. Falls
/// back to the raw filter when nothing matches, preserving legacy raw-path callers.
fn resolve_paths_for_table_filter(
    conn: &Connection,
    table: &str,
    project_filter: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    // `table` is a fixed internal literal (never user input), so interpolating
    // it into the DISTINCT query is safe. The set is small (one row per project
    // that ever wrote to the table), bounded by project count, not row count.
    let mut stmt = conn.prepare(&format!("SELECT DISTINCT project_path FROM {table}"))?;
    // Read as Option<String>: some tables (smart_notes, project_key_files) can
    // hold legacy rows with a NULL project_path. A non-Option get() throws
    // "Invalid column type Null" and crashes the whole session-detail view. A
    // NULL path can never normalize to a resolved identity, so we drop them.
    let all_paths: Vec<String> = stmt
        .query_map([], |row| row.get::<_, Option<String>>(0))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect();

    let normalized_filter = normalize_stored_project_path(project_filter);
    let mut matched: Vec<String> = all_paths
        .into_iter()
        .filter(|path| normalize_stored_project_path(path) == normalized_filter)
        .collect();

    if matched.is_empty() {
        // No stored path resolves to this identity. Treat the incoming value as
        // a legacy raw path filter for backward compatibility.
        matched.push(project_filter.to_string());
    }
    Ok(matched)
}

/// Build a SQL `IN (?, ?, ...)` placeholder string starting at parameter
/// index `start_idx` (1-based). Returns the placeholder string. Caller is
/// responsible for pushing the actual values onto the params vec in the same
/// order.
fn build_in_placeholders(count: usize, start_idx: usize) -> String {
    (0..count)
        .map(|i| format!("?{}", start_idx + i))
        .collect::<Vec<_>>()
        .join(", ")
}

fn enrich_memories_workspace_source(
    conn: &Connection,
    workspace_id: Option<i64>,
    memories: &mut [Memory],
) -> Result<(), rusqlite::Error> {
    let Some(ws_id) = workspace_id else {
        return Ok(());
    };
    if !crate::workspaces::workspace_schema_ready(conn)? {
        return Ok(());
    }
    for mem in memories.iter_mut() {
        mem.source_display_name = crate::workspaces::display_name_for_memory_in_workspace(
            conn,
            ws_id,
            &mem.project_path,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn get_memories(
    conn: &Connection,
    project_filter: Option<&str>,
    workspace_filter: Option<i64>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    // The dashboard opens the DB read-only and never migrates it (the plugin owns
    // the schema lifecycle). A new dashboard against a pre-v44 plugin DB lacks the
    // classify columns — select literal defaults instead so the viewer degrades
    // rather than erroring. Mapper indices 21/22/23 stay stable either way.
    let classify_cols = if memories_has_classify_columns(conn) {
        "m.importance, m.scope, m.shareable,"
    } else {
        "50 AS importance, 'project' AS scope, 0 AS shareable,"
    };

    // Degrade gracefully on a pre-vN / never-initialized DB that has no
    // `memory_embeddings` table: the EXISTS subquery would error the whole query
    // (the dashboard opens DBs read-only and never creates tables). Mirror the
    // classify-column degradation and report no embeddings instead of crashing.
    let has_embedding_select = if table_exists(conn, "memory_embeddings") {
        HAS_EMBEDDING_SELECT
    } else {
        "0 AS has_embedding"
    };

    let raw_search = search_query.unwrap_or("").trim().to_string();
    let has_search = !raw_search.is_empty();

    // Sanitize search query for FTS5: wrap each token in double quotes so
    // special characters (/, -, etc.) are treated as literals, matching the
    // plugin's sanitizeFtsQuery() approach.
    let sanitized_fts = if has_search {
        let tokens: Vec<String> = raw_search
            .split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
            .collect();
        if tokens.is_empty() {
            String::new()
        } else {
            tokens.join(" ")
        }
    } else {
        String::new()
    };
    let use_fts = !sanitized_fts.is_empty();
    // For very short queries (< 3 chars) or if FTS sanitization produces nothing,
    // fall back to LIKE which handles partial matches better
    let use_like_fallback = has_search && (!use_fts || raw_search.len() < 3);
    let like_pattern = format!("%{}%", raw_search.replace('%', "\\%").replace('_', "\\_"));

    // Build WHERE clauses and params dynamically
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if use_fts && !use_like_fallback {
        params.push(Box::new(sanitized_fts.clone()));
        // FTS match uses the first param
    } else if has_search {
        params.push(Box::new(like_pattern.clone()));
        // LIKE uses the first param
    }

    // Workspace filter takes precedence over single-project filter (union of members).
    let resolved_paths: Vec<String> = if let Some(ws_id) = workspace_filter {
        crate::workspaces::resolve_workspace_filter_paths(conn, ws_id)?
    } else if let Some(p) = project_filter {
        resolve_paths_for_memory_filter(conn, p)?
    } else {
        Vec::new()
    };
    if !resolved_paths.is_empty() {
        let start_idx = params.len() + 1;
        for path in &resolved_paths {
            params.push(Box::new(path.clone()));
        }
        let placeholders = build_in_placeholders(resolved_paths.len(), start_idx);
        conditions.push(format!("m.project_path IN ({})", placeholders));
    } else if workspace_filter.is_some() || project_filter.is_some() {
        // A filter WAS requested but resolved to zero paths (e.g. a workspace
        // with no members). Force an empty result — falling through to "no
        // filter" would surface ALL memories under that filter, risking a
        // bulk archive/delete against the wrong rows.
        conditions.push("0 = 1".to_string());
    }
    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("m.status = ?{}", params.len()));
    }
    if let Some(c) = category_filter {
        params.push(Box::new(c.to_string()));
        conditions.push(format!("m.category = ?{}", params.len()));
    }

    let where_extra = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    // Add limit and offset
    let limit_idx = params.len() + 1;
    let offset_idx = params.len() + 2;
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let sql = if use_fts && !use_like_fallback {
        // FTS5 search with sanitized query
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    {classify_cols}
                    {has_embedding}
             FROM memories m
             INNER JOIN memories_fts ON memories_fts.rowid = m.id
             WHERE memories_fts MATCH ?1
             {}
             ORDER BY rank
             LIMIT ?{} OFFSET ?{}",
            where_extra,
            limit_idx,
            offset_idx,
            has_embedding = has_embedding_select,
        )
    } else if has_search {
        // LIKE fallback for short queries or special-character-heavy input
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    {classify_cols}
                    {has_embedding}
             FROM memories m
             WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
             {}
             ORDER BY m.updated_at DESC
              LIMIT ?{} OFFSET ?{}",
            where_extra,
            limit_idx,
            offset_idx,
            has_embedding = has_embedding_select,
        )
    } else {
        format!(
            "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                    {classify_cols}
                    {has_embedding}
             FROM memories m
             WHERE 1=1
             {}
             ORDER BY m.updated_at DESC
              LIMIT ?{} OFFSET ?{}",
            where_extra,
            limit_idx,
            offset_idx,
            has_embedding = has_embedding_select,
        )
    };

    // Try FTS first; if it fails (e.g. malformed query despite sanitization), fall back to LIKE
    let result = {
        let mut stmt = conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
        rows.collect::<Result<Vec<_>, _>>()
    };

    match result {
        Ok(mut memories) if !memories.is_empty() || !use_fts => {
            enrich_memories_workspace_source(conn, workspace_filter, &mut memories)?;
            Ok(memories)
        }
        Ok(_empty) if use_fts && !use_like_fallback => {
            // FTS returned nothing — retry with LIKE for better partial matching
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        {classify_cols}
                        {has_embedding}
                 FROM memories m
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra,
                limit_idx,
                offset_idx,
                has_embedding = has_embedding_select,
            );
            // Rebuild params with LIKE pattern instead of FTS query.
            // Project filter uses the same resolved_paths set computed at the
            // top of this function — the path-set is identity-stable for the
            // duration of this call.
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            // Re-add filter params (matches the order used to build where_extra above)
            for path in &resolved_paths {
                like_params.push(Box::new(path.clone()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            let mut memories: Vec<Memory> = rows.collect::<Result<Vec<_>, _>>()?;
            enrich_memories_workspace_source(conn, workspace_filter, &mut memories)?;
            Ok(memories)
        }
        Err(e) if use_fts => {
            // FTS query failed — fall back to LIKE
            eprintln!("FTS search failed, falling back to LIKE: {}", e);
            let like_sql = format!(
                "SELECT m.id, m.project_path, m.category, m.content, m.normalized_hash,
                        m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
                        m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
                        m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
                        m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
                        {classify_cols}
                        {has_embedding}
                 FROM memories m
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra,
                limit_idx,
                offset_idx,
                has_embedding = has_embedding_select,
            );
            let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
            like_params.push(Box::new(like_pattern));
            for path in &resolved_paths {
                like_params.push(Box::new(path.clone()));
            }
            if let Some(s) = status_filter {
                like_params.push(Box::new(s.to_string()));
            }
            if let Some(c) = category_filter {
                like_params.push(Box::new(c.to_string()));
            }
            like_params.push(Box::new(limit));
            like_params.push(Box::new(offset));

            let mut stmt = conn.prepare(&like_sql)?;
            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                like_params.iter().map(|p| p.as_ref()).collect();
            let rows = stmt.query_map(param_refs.as_slice(), map_memory_row)?;
            let mut memories: Vec<Memory> = rows.collect::<Result<Vec<_>, _>>()?;
            enrich_memories_workspace_source(conn, workspace_filter, &mut memories)?;
            Ok(memories)
        }
        other => other,
    }
}

pub fn get_primers(
    conn: &Connection,
    project: Option<&str>,
) -> Result<Vec<Primer>, rusqlite::Error> {
    let has_primers: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'primers'",
        [],
        |row| row.get(0),
    )?;
    if has_primers == 0 {
        return Ok(Vec::new());
    }
    let sql = if project.is_some() {
        "SELECT id, project_path, question, answer, status, total_support, last_observed_at, answer_refreshed_at, source_candidate_ids, created_at, updated_at
         FROM primers
         WHERE project_path = ?1
         ORDER BY status ASC, COALESCE(last_observed_at, created_at) DESC, id ASC"
    } else {
        "SELECT id, project_path, question, answer, status, total_support, last_observed_at, answer_refreshed_at, source_candidate_ids, created_at, updated_at
         FROM primers
         ORDER BY project_path ASC, status ASC, COALESCE(last_observed_at, created_at) DESC, id ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| -> Result<Primer, rusqlite::Error> {
        Ok(Primer {
            id: row.get(0)?,
            project_path: row.get(1)?,
            question: row.get(2)?,
            answer: row.get(3)?,
            status: row.get(4)?,
            total_support: row.get(5)?,
            last_observed_at: row.get(6)?,
            answer_refreshed_at: row.get(7)?,
            source_candidate_ids: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    };
    if let Some(project) = project {
        stmt.query_map(params![project], map_row)?.collect()
    } else {
        stmt.query_map([], map_row)?.collect()
    }
}

/// Read-only view of pending primer candidates (questions the historian emitted
/// that have not yet recurred enough to promote). Newest first. Degrades to an
/// empty list on pre-vN databases that lack the table.
pub fn get_primer_candidates(
    conn: &Connection,
    project: Option<&str>,
) -> Result<Vec<PrimerCandidate>, rusqlite::Error> {
    if !table_exists(conn, "primer_candidates") {
        return Ok(Vec::new());
    }
    let sql = if project.is_some() {
        "SELECT id, project_path, question, session_id, source_compartment_start, source_compartment_end, source_message_time, created_at
         FROM primer_candidates
         WHERE project_path = ?1
         ORDER BY source_message_time DESC, id DESC"
    } else {
        "SELECT id, project_path, question, session_id, source_compartment_start, source_compartment_end, source_message_time, created_at
         FROM primer_candidates
         ORDER BY project_path ASC, source_message_time DESC, id DESC"
    };
    let mut stmt = conn.prepare(sql)?;
    let map_row = |row: &rusqlite::Row<'_>| -> Result<PrimerCandidate, rusqlite::Error> {
        Ok(PrimerCandidate {
            id: row.get(0)?,
            project_path: row.get(1)?,
            question: row.get(2)?,
            session_id: row.get(3)?,
            source_compartment_start: row.get(4)?,
            source_compartment_end: row.get(5)?,
            source_message_time: row.get(6)?,
            created_at: row.get(7)?,
        })
    };
    if let Some(project) = project {
        stmt.query_map(params![project], map_row)?.collect()
    } else {
        stmt.query_map([], map_row)?.collect()
    }
}

/// Read the latest project-scoped memory mural without requiring the dashboard
/// to migrate the plugin database. Older databases simply have no mural row.
pub fn get_mural(
    conn: &Connection,
    project: Option<&str>,
) -> Result<Option<MuralManifest>, rusqlite::Error> {
    let Some(project) = project else {
        return Ok(None);
    };
    if !table_exists(conn, "mural_manifest") {
        return Ok(None);
    }

    // The mural has a fixed size, so use 1,521 as its fallback vision-token
    // estimate. Older databases may not have a token_estimate column; if a newer
    // database does, use its value instead.
    let token_estimate = if table_has_column(conn, "mural_manifest", "token_estimate") {
        "COALESCE(token_estimate, 1521)"
    } else {
        "1521"
    };
    let sql = format!(
        "SELECT project_path, image, rendered_at, {token_estimate} AS token_estimate, width, height
         FROM mural_manifest
         WHERE project_path = ?1"
    );
    conn.query_row(&sql, params![project], |row| {
        Ok(MuralManifest {
            project_path: row.get(0)?,
            image: row.get(1)?,
            rendered_at: row.get(2)?,
            token_estimate: row.get(3)?,
            width: row.get(4)?,
            height: row.get(5)?,
        })
    })
    .optional()
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> bool {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        [column],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

fn table_has_columns(conn: &Connection, table: &str, columns: &[&str]) -> bool {
    columns
        .iter()
        .all(|column| table_has_column(conn, table, column))
}

/// True when the `memories` table carries the v44 classify columns. The
/// dashboard never migrates, so a new dashboard can face a pre-v44 plugin DB.
fn memories_has_classify_columns(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('memories') WHERE name IN ('importance','scope','shareable')",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n == 3)
    .unwrap_or(false)
}

fn map_memory_row(row: &rusqlite::Row<'_>) -> Result<Memory, rusqlite::Error> {
    Ok(Memory {
        id: row.get(0)?,
        project_path: row.get(1)?,
        category: row.get(2)?,
        content: row.get(3)?,
        normalized_hash: row.get(4)?,
        source_session_id: row.get(5)?,
        source_type: row.get(6)?,
        seen_count: row.get(7)?,
        retrieval_count: row.get(8)?,
        first_seen_at: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_seen_at: row.get(12)?,
        last_retrieved_at: row.get(13)?,
        status: row.get(14)?,
        expires_at: row.get(15)?,
        verification_status: row.get(16)?,
        verified_at: row.get(17)?,
        superseded_by_memory_id: row.get(18)?,
        merged_from: row.get(19)?,
        metadata_json: row.get(20)?,
        importance: row.get::<_, Option<i64>>(21)?.unwrap_or(50),
        scope: row
            .get::<_, Option<String>>(22)?
            .unwrap_or_else(|| "project".to_string()),
        shareable: row.get::<_, Option<i64>>(23)?.unwrap_or(0) != 0,
        has_embedding: row.get::<_, i64>(24)? != 0,
        source_display_name: None,
    })
}

pub fn get_memory_stats(
    conn: &Connection,
    project_filter: Option<&str>,
    workspace_filter: Option<i64>,
) -> Result<MemoryStats, rusqlite::Error> {
    let resolved_paths: Vec<String> = if let Some(ws_id) = workspace_filter {
        crate::workspaces::resolve_workspace_filter_paths(conn, ws_id)?
    } else if let Some(p) = project_filter {
        resolve_paths_for_memory_filter(conn, p)?
    } else {
        Vec::new()
    };

    // A filter requested but resolved to zero paths (e.g. an empty workspace)
    // must report ZERO stats, not global totals — otherwise the UI shows every
    // memory's counts under an empty workspace.
    let filter_requested = workspace_filter.is_some() || project_filter.is_some();

    // Build a `project_path IN (?, ?, ...)` fragment and the param refs that
    // back it. Both are empty when no project filter is active.
    let (path_in_clause, path_params): (String, Vec<&dyn rusqlite::types::ToSql>) =
        if resolved_paths.is_empty() {
            if filter_requested {
                ("0 = 1".to_string(), Vec::new())
            } else {
                (String::new(), Vec::new())
            }
        } else {
            let placeholders = build_in_placeholders(resolved_paths.len(), 1);
            (
                format!("project_path IN ({})", placeholders),
                resolved_paths
                    .iter()
                    .map(|p| p as &dyn rusqlite::types::ToSql)
                    .collect(),
            )
        };

    // Helper: assemble the full WHERE clause for a query that may already
    // have other conditions. Returns `WHERE <conds>` or empty.
    let where_with_extra = |existing: &str, has_filter: bool| -> String {
        match (existing.is_empty(), has_filter) {
            (true, true) => format!("WHERE {}", path_in_clause),
            (false, true) => format!("WHERE {} AND {}", existing, path_in_clause),
            (true, false) => String::new(),
            (false, false) => format!("WHERE {}", existing),
        }
    };

    // `path_in_clause` is non-empty both for a real IN-list AND for the forced
    // `0 = 1` empty-filter case, so key the WHERE assembly off it (not off
    // resolved_paths) to honor the zero-stats contract above.
    let has_filter = !path_in_clause.is_empty();

    let total: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let active: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'active'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let permanent: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'permanent'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let archived: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("status = 'archived'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;

    // Count distinct memories that have at least one embedding row. Multiple rows per
    // memory (one per model_id) must not inflate this stat. Guard against a
    // pre-vN/never-initialized DB with no memory_embeddings table (read-only
    // dashboard never creates it) — report 0 rather than crashing the stats query.
    let with_embeddings: i64 = if !table_exists(conn, "memory_embeddings") {
        0
    } else if has_filter {
        if resolved_paths.is_empty() {
            // Empty filter resolves to zero rows — honor the same zero-stats
            // contract the other counts get from the `0 = 1` sentinel. Rebuilding
            // an IN-list from an empty resolved_paths would emit invalid
            // `IN ()` SQL and crash the whole stats query.
            0
        } else {
            let qualified_in = format!(
                "m.project_path IN ({})",
                build_in_placeholders(resolved_paths.len(), 1)
            );
            conn.query_row(
                &format!(
                    "SELECT COUNT(DISTINCT me.memory_id) FROM memory_embeddings me JOIN memories m ON me.memory_id = m.id WHERE {}",
                    qualified_in
                ),
                path_params.as_slice(),
                |r| r.get(0),
            )?
        }
    } else {
        conn.query_row(
            "SELECT COUNT(DISTINCT memory_id) FROM memory_embeddings",
            [],
            |r| r.get(0),
        )?
    };

    let cat_sql = format!(
        "SELECT category, COUNT(*) as cnt FROM memories {} GROUP BY category ORDER BY cnt DESC",
        where_with_extra("status != 'archived'", has_filter)
    );
    let mut stmt = conn.prepare(&cat_sql)?;
    let categories: Vec<CategoryCount> = stmt
        .query_map(path_params.as_slice(), |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(MemoryStats {
        total,
        active,
        permanent,
        archived,
        with_embeddings,
        categories,
    })
}

fn mutation_race_error() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MemoryMutationTarget {
    project_path: String,
    category: Option<String>,
    status: Option<String>,
}

fn lookup_memory_mutation_target(
    conn: &Connection,
    memory_id: i64,
) -> Result<MemoryMutationTarget, rusqlite::Error> {
    conn.query_row(
        "SELECT project_path, category, status FROM memories WHERE id = ?1",
        params![memory_id],
        |row| {
            Ok(MemoryMutationTarget {
                project_path: row.get(0)?,
                category: row.get(1)?,
                status: row.get(2)?,
            })
        },
    )
}

fn fetch_memory_mutation_targets(
    conn: &Connection,
    memory_ids: &[i64],
) -> Result<HashMap<i64, MemoryMutationTarget>, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, project_path, category, status FROM memories WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(memory_ids.iter()), |row| {
        Ok((
            row.get::<_, i64>(0)?,
            MemoryMutationTarget {
                project_path: row.get(1)?,
                category: row.get(2)?,
                status: row.get(3)?,
            },
        ))
    })?;

    rows.collect::<Result<HashMap<_, _>, _>>()
}

fn fetch_memory_project_paths_in_tx(
    tx: &Transaction<'_>,
    memory_ids: &[i64],
) -> Result<HashMap<i64, String>, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT id, project_path FROM memories WHERE id IN ({placeholders})");
    let mut stmt = tx.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(memory_ids.iter()), |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;

    rows.collect::<Result<HashMap<_, _>, _>>()
}

fn normalize_memory_project_identities(paths: &HashMap<i64, String>) -> HashSet<String> {
    paths
        .values()
        .map(|stored| normalize_stored_project_path(stored))
        .filter(|identity| !identity.is_empty())
        .collect()
}

fn verify_memory_project_path_unchanged(
    tx: &Transaction<'_>,
    memory_id: i64,
    expected: &str,
) -> Result<(), rusqlite::Error> {
    let current: Option<String> = tx
        .query_row(
            "SELECT project_path FROM memories WHERE id = ?1",
            params![memory_id],
            |row| row.get(0),
        )
        .optional()?;

    if current.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn verify_bulk_memory_project_paths_unchanged(
    tx: &Transaction<'_>,
    expected: &HashMap<i64, String>,
) -> Result<(), rusqlite::Error> {
    if expected.is_empty() {
        return Ok(());
    }

    let mut ids: Vec<i64> = expected.keys().copied().collect();
    ids.sort_unstable();
    let current = fetch_memory_project_paths_in_tx(tx, &ids)?;
    if current == *expected {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn bump_project_memory_epoch_for_identity(
    tx: &Transaction<'_>,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    if identity.is_empty() {
        return Ok(());
    }

    tx.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, 1, 0, ?2)
         ON CONFLICT(project_path) DO UPDATE SET
           project_memory_epoch = project_memory_epoch + 1,
           updated_at = excluded.updated_at",
        params![identity, now_millis()],
    )?;
    Ok(())
}

fn queue_memory_mutation(
    tx: &Transaction<'_>,
    project_path: &str,
    mutation_type: &str,
    target_memory_id: i64,
    superseded_by_id: Option<i64>,
    category: Option<&str>,
    new_content: Option<&str>,
) -> Result<(), rusqlite::Error> {
    // Store the row under the resolved identity (git:/dir:), mirroring the plugin's
    // queueMemoryMutation. The render-side filter queries by resolved identity, so a
    // raw-path row would be invisible to it. Idempotent on already-resolved paths
    // (every live memory row), defensive for any legacy raw path.
    let identity = normalize_stored_project_path(project_path);
    tx.execute(
        "INSERT INTO memory_mutation_log
           (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            identity,
            mutation_type,
            target_memory_id,
            superseded_by_id,
            category,
            new_content,
            now_millis()
        ],
    )?;
    Ok(())
}

fn bump_project_user_profile_version(tx: &Transaction<'_>) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES ('__global__', 0, 1, ?1)
         ON CONFLICT(project_path) DO UPDATE SET
           project_user_profile_version = project_user_profile_version + 1,
           updated_at = excluded.updated_at",
        params![now_millis()],
    )?;
    Ok(())
}

fn lookup_session_fact_session_id(
    conn: &Connection,
    fact_id: i64,
) -> Result<String, rusqlite::Error> {
    conn.query_row(
        "SELECT session_id FROM session_facts WHERE id = ?1",
        params![fact_id],
        |row| row.get(0),
    )
}

fn verify_session_fact_session_unchanged(
    tx: &Transaction<'_>,
    fact_id: i64,
    expected_session_id: &str,
) -> Result<(), rusqlite::Error> {
    let current: Option<String> = tx
        .query_row(
            "SELECT session_id FROM session_facts WHERE id = ?1",
            params![fact_id],
            |row| row.get(0),
        )
        .optional()?;

    if current.as_deref() == Some(expected_session_id) {
        Ok(())
    } else {
        Err(mutation_race_error())
    }
}

fn bump_session_facts_version_for_session(
    tx: &Transaction<'_>,
    session_id: &str,
) -> Result<(), rusqlite::Error> {
    tx.execute(
        "INSERT INTO session_meta (session_id, session_facts_version)
         VALUES (?1, 1)
         ON CONFLICT(session_id) DO UPDATE SET
           session_facts_version = session_facts_version + 1",
        params![session_id],
    )?;
    Ok(())
}

/// Exception-only cache invalidation for schema/cache-format upgrades and explicit clear-all UI.
/// Routine memory, user-memory, and fact mutations must use scoped version counters instead.
pub fn invalidate_all_memory_block_caches(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE session_meta
         SET memory_block_cache = '',
             memory_block_ids = '',
             cached_m0_bytes = NULL,
             cached_m1_bytes = NULL,
             cached_m0_max_memory_mutation_id = NULL
         WHERE memory_block_cache != ''
            OR memory_block_ids != ''
            OR cached_m0_bytes IS NOT NULL
            OR cached_m1_bytes IS NOT NULL
            OR cached_m0_max_memory_mutation_id IS NOT NULL",
        [],
    )
}

pub fn update_memory_status(
    conn: &mut Connection,
    memory_id: i64,
    new_status: &str,
) -> Result<(), rusqlite::Error> {
    // Reject any status outside the canonical set before touching the DB. A
    // malformed call setting status="archive" (vs "archived") or any free string
    // would make the memory vanish from active/permanent/archived logic with no
    // valid epoch/delta interpretation.
    if !matches!(new_status, "active" | "permanent" | "archived") {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Invalid memory status '{new_status}' (expected active, permanent, or archived)."
            )),
        ));
    }
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;
    // Any transition that CHANGES which memories enter or how they rank in the
    // m[0] baseline must bump the epoch to invalidate cached m[0]. That covers
    // every status change into an injectable status (`active`/`permanent`) from a
    // different status — including archived->active/permanent (restore) AND
    // active<->permanent (pin/unpin), since memory selection is permanent-first
    // under budget pressure, so pinning reorders the rendered set. Gating only on
    // archived-origin left active<->permanent invalidating nothing.
    let prior_status = target.status.as_deref();
    let into_injectable = new_status == "active" || new_status == "permanent";
    let needs_epoch_bump = into_injectable && prior_status != Some(new_status);
    let project_identity = if needs_epoch_bump {
        Some(normalize_stored_project_path(&target.project_path))
    } else {
        None
    };
    let is_archive = new_status == "archived" && prior_status != Some("archived");

    // Phase B: re-check the target row, mutate, and queue/bump in one tx.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;
    tx.execute(
        "UPDATE memories SET status = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_status, now_millis(), memory_id],
    )?;
    // Resolve workspace fan-out INSIDE the write transaction so a concurrent
    // add-member committing between Phase A and here can't leave a new member's
    // epoch un-bumped (it would then miss this restored memory).
    let epoch_bump_identities = if let Some(ref id) = project_identity {
        Some(crate::workspaces::workspace_member_identities_for_project(
            &tx, id,
        )?)
    } else {
        None
    };
    if let Some(identities) = epoch_bump_identities.as_ref() {
        crate::workspaces::bump_epochs_for_identities(&tx, identities)?;
    } else if is_archive {
        queue_memory_mutation(
            &tx,
            &target.project_path,
            "archive",
            memory_id,
            None,
            target.category.as_deref(),
            None,
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_memory_content(
    conn: &mut Connection,
    memory_id: i64,
    new_content: &str,
) -> Result<(), rusqlite::Error> {
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;
    let new_hash = normalize_hash(new_content);

    // Phase B: re-check the target row, mutate, clear stale embeddings, and queue once.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;

    // Pre-check the UNIQUE(project_path, category, normalized_hash) constraint
    // INSIDE the Immediate transaction (no TOCTOU). If editing this memory's
    // content makes its hash match another memory in the same project+category,
    // a plain UPDATE aborts with a raw `UNIQUE constraint failed: ...` string
    // that surfaces verbatim in the dashboard toast. Mirror the TS plugin's
    // friendly message so the user knows to merge/archive the duplicate.
    // `category = ?2` (not `IS`): SQLite's UNIQUE treats NULL categories as
    // distinct (NULLs never collide), and `category = NULL` is never true — so
    // a NULL category yields no match here, exactly mirroring the constraint
    // the real UPDATE would (not) violate. Avoids a false rejection on NULL.
    let collision_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM memories
             WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3 AND id != ?4
             LIMIT 1",
            params![target.project_path, target.category, new_hash, memory_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(existing_id) = collision_id {
        // SqliteFailure(_, Some(msg)) Displays as exactly `msg`, so commands.rs's
        // `.to_string()` surfaces this friendly text (not a raw SQLite error)
        // in the dashboard toast. rusqlite 0.31 has no ModuleError variant.
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Memory content already exists as ID {existing_id} in this category; merge or archive the duplicate first."
            )),
        ));
    }

    tx.execute(
        "UPDATE memories SET content = ?1, normalized_hash = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_content, new_hash, now_millis(), memory_id],
    )?;
    // The classify `shareable` verdict was scored against the OLD content; a
    // dashboard content edit invalidates it. Fail closed → private; the dreamer
    // re-scores later. Mirrors the plugin's updateMemoryContent. Column-guarded
    // for pre-v44 DBs.
    if memories_has_classify_columns(&tx) {
        tx.execute(
            "UPDATE memories SET shareable = 0 WHERE id = ?1",
            params![memory_id],
        )?;
    }
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![memory_id],
    )?;
    queue_memory_mutation(
        &tx,
        &target.project_path,
        "update",
        memory_id,
        None,
        target.category.as_deref(),
        Some(new_content),
    )?;
    tx.commit()?;
    Ok(())
}

pub fn update_memory_category(
    conn: &mut Connection,
    memory_id: i64,
    new_category: &str,
) -> Result<(), rusqlite::Error> {
    const VALID_CATEGORIES: [&str; 5] = [
        "PROJECT_RULES",
        "ARCHITECTURE",
        "CONSTRAINTS",
        "CONFIG_VALUES",
        "NAMING",
    ];

    if !VALID_CATEGORIES.contains(&new_category) {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Invalid category: {new_category}. Must be one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING."
            )),
        ));
    }

    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;

    // No-op guard: changing a memory to its current category must NOT bump any
    // epoch (that would force a needless hard fold across every workspace member).
    if target.category.as_deref() == Some(new_category) {
        return Ok(());
    }

    // Phase B: re-check the target row, mutate, and bump epochs once.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;

    let normalized_hash: String = tx.query_row(
        "SELECT normalized_hash FROM memories WHERE id = ?1",
        params![memory_id],
        |row| row.get(0),
    )?;

    // Pre-check the UNIQUE(project_path, category, normalized_hash) constraint
    let collision_id: Option<i64> = tx
        .query_row(
            "SELECT id FROM memories
             WHERE project_path = ?1 AND category = ?2 AND normalized_hash = ?3 AND id != ?4
             LIMIT 1",
            params![
                target.project_path,
                new_category,
                normalized_hash,
                memory_id
            ],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(existing_id) = collision_id {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Memory already exists as ID {existing_id} in {new_category}; merge or archive the duplicate first."
            )),
        ));
    }

    tx.execute(
        "UPDATE memories SET category = ?1, updated_at = ?2 WHERE id = ?3",
        params![new_category, now_millis(), memory_id],
    )?;

    // A category change is visibility- AND render-changing: it alters the heading
    // a memory renders under in <project-memory>, and (in a workspace) can flip a
    // foreign memory between shared and non-shared. Both change m[0] bytes, so bump
    // member epochs to force a hard fold — exactly like update_memory_status. The
    // hard fold re-renders m[0] from true memory state, so we do NOT also queue an
    // m[1] "update" delta (epoch-bump XOR delta, matching the status path). Fan-out
    // is resolved INSIDE the write tx so a concurrent add-member can't miss it.
    let project_identity = normalize_stored_project_path(&target.project_path);
    let epoch_bump_identities =
        crate::workspaces::workspace_member_identities_for_project(&tx, &project_identity)?;
    crate::workspaces::bump_epochs_for_identities(&tx, &epoch_bump_identities)?;

    tx.commit()?;
    Ok(())
}

pub fn delete_memory(conn: &mut Connection, memory_id: i64) -> Result<(), rusqlite::Error> {
    // Phase A: resolve the target row before opening a write transaction.
    let target = lookup_memory_mutation_target(conn, memory_id)?;

    // Phase B: re-check, queue before delete, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_memory_project_path_unchanged(&tx, memory_id, &target.project_path)?;
    queue_memory_mutation(
        &tx,
        &target.project_path,
        "delete",
        memory_id,
        None,
        target.category.as_deref(),
        None,
    )?;
    tx.execute(
        "DELETE FROM memory_embeddings WHERE memory_id = ?1",
        params![memory_id],
    )?;
    tx.execute("DELETE FROM memories WHERE id = ?1", params![memory_id])?;
    tx.commit()?;
    Ok(())
}

/// Bulk-update status for a set of memory IDs in one transaction.
///
/// Empty input is a no-op and returns 0 (affected rows).
pub fn bulk_update_memory_status(
    conn: &mut Connection,
    memory_ids: &[i64],
    new_status: &str,
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    // Phase A: one read round-trip for all target rows, then identity normalization lock-free.
    let phase_a_targets = fetch_memory_mutation_targets(conn, memory_ids)?;
    let phase_a_paths: HashMap<i64, String> = phase_a_targets
        .iter()
        .map(|(id, target)| (*id, target.project_path.clone()))
        .collect();
    // Both `active` and `permanent` re-enter the m[0] baseline, so a bulk
    // status change INTO either counts as a restore for epoch-bump purposes
    // (matches update_memory_status). Only bump for rows whose status ACTUALLY
    // changes — a no-op (already in new_status) must not bust the epoch and
    // force a needless m[0]/m[1] rematerialization (mirrors the single-row
    // `prior_status != Some(new_status)` gate).
    let is_restore = new_status == "active" || new_status == "permanent";
    let is_archive = new_status == "archived";
    let changed_paths: HashMap<i64, String> = phase_a_targets
        .iter()
        .filter(|(_, target)| target.status.as_deref() != Some(new_status))
        .map(|(id, target)| (*id, target.project_path.clone()))
        .collect();
    let phase_a_identities = if is_restore {
        normalize_memory_project_identities(&changed_paths)
    } else {
        HashSet::new()
    };

    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql =
        format!("UPDATE memories SET status = ?, updated_at = ? WHERE id IN ({placeholders})");
    let now = now_millis();

    // Phase B: bulk re-verify, bulk update, then queue per archive or bump per restore.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_bulk_memory_project_paths_unchanged(&tx, &phase_a_paths)?;
    let affected = {
        let status_value = new_status.to_string();
        let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(2 + memory_ids.len());
        params_vec.push(&status_value);
        params_vec.push(&now);
        for id in memory_ids {
            params_vec.push(id);
        }
        tx.execute(&sql, params_from_iter(params_vec))?
    };
    // Resolve workspace fan-out INSIDE the write transaction (same TOCTOU fix as
    // update_memory_status): a concurrent add-member must not slip a new member
    // in with a stale epoch between Phase A and the bump.
    if is_restore {
        let mut epoch_bump_identities = HashSet::new();
        for identity in &phase_a_identities {
            epoch_bump_identities.extend(
                crate::workspaces::workspace_member_identities_for_project(&tx, identity)?,
            );
        }
        crate::workspaces::bump_epochs_for_identities(&tx, &epoch_bump_identities)?;
    } else if is_archive {
        for id in memory_ids {
            if let Some(target) = phase_a_targets.get(id) {
                if target.status.as_deref() != Some("archived") {
                    queue_memory_mutation(
                        &tx,
                        &target.project_path,
                        "archive",
                        *id,
                        None,
                        target.category.as_deref(),
                        None,
                    )?;
                }
            }
        }
    }
    tx.commit()?;
    Ok(affected)
}

/// Bulk-delete memories and their embeddings in one transaction.
pub fn bulk_delete_memory(
    conn: &mut Connection,
    memory_ids: &[i64],
) -> Result<usize, rusqlite::Error> {
    if memory_ids.is_empty() {
        return Ok(0);
    }

    // Phase A: one read round-trip for all target rows, then identity normalization lock-free.
    let phase_a_targets = fetch_memory_mutation_targets(conn, memory_ids)?;
    let phase_a_paths: HashMap<i64, String> = phase_a_targets
        .iter()
        .map(|(id, target)| (*id, target.project_path.clone()))
        .collect();
    let placeholders = memory_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");

    // Phase B: bulk re-verify, queue one delete per memory, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_bulk_memory_project_paths_unchanged(&tx, &phase_a_paths)?;
    for id in memory_ids {
        if let Some(target) = phase_a_targets.get(id) {
            queue_memory_mutation(
                &tx,
                &target.project_path,
                "delete",
                *id,
                None,
                target.category.as_deref(),
                None,
            )?;
        }
    }
    {
        let sql = format!("DELETE FROM memory_embeddings WHERE memory_id IN ({placeholders})");
        tx.execute(&sql, params_from_iter(memory_ids.iter()))?;
    }
    let affected = {
        let sql = format!("DELETE FROM memories WHERE id IN ({placeholders})");
        tx.execute(&sql, params_from_iter(memory_ids.iter()))?
    };
    tx.commit()?;
    Ok(affected)
}

// ── Session queries ─────────────────────────────────────────

pub fn get_sessions(conn: &Connection) -> Result<Vec<SessionSummary>, rusqlite::Error> {
    let sql = "
        WITH comp_stats AS (
            SELECT session_id,
                   COUNT(*) AS cnt,
                   MIN(start_message) AS first_start,
                   MAX(end_message) AS last_end
            FROM compartments GROUP BY session_id
        ),
        fact_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM session_facts GROUP BY session_id
        ),
        note_stats AS (
            SELECT session_id, COUNT(*) AS cnt FROM notes WHERE type = 'session' AND status = 'active' GROUP BY session_id
        )
        SELECT
            sm.session_id,
            COALESCE(cs.cnt, 0),
            COALESCE(fs.cnt, 0),
            COALESCE(ns.cnt, 0),
            cs.first_start,
            cs.last_end,
            sm.last_response_time,
            sm.last_context_percentage,
            sm.is_subagent
        FROM session_meta sm
        LEFT JOIN comp_stats cs ON cs.session_id = sm.session_id
        LEFT JOIN fact_stats fs ON fs.session_id = sm.session_id
        LEFT JOIN note_stats ns ON ns.session_id = sm.session_id
        ORDER BY sm.last_response_time DESC NULLS LAST
    ";
    let mut stmt = conn.prepare(sql)?;
    let mut sessions: Vec<SessionSummary> = stmt
        .query_map([], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: None,
                project_identity: None,
                compartment_count: row.get(1)?,
                fact_count: row.get(2)?,
                note_count: row.get(3)?,
                first_compartment_start: row.get(4)?,
                last_compartment_end: row.get(5)?,
                last_response_time: row.get(6)?,
                last_context_percentage: row.get(7)?,
                is_subagent: row.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve session titles from OpenCode and project identity from the
    // recorded session_projects mapping.
    let session_info = resolve_session_info(&sessions);
    for session in &mut sessions {
        if let Some(info) = session_info.get(&session.session_id) {
            session.title = Some(info.0.clone());
            if !info.1.is_empty() {
                session.project_identity = Some(info.1.clone());
            }
        }
    }

    Ok(sessions)
}

pub fn list_opencode_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    if filter.harness.is_some_and(|h| h != Harness::Opencode) {
        return Vec::new();
    }
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Vec::new();
    };
    let Ok(conn) = open_readonly(&opencode_db_path) else {
        return Vec::new();
    };
    // No message-table join: the session list does not show a message count, and
    // joining/grouping the 300k+ row `message` table per call was the dominant
    // cost (a multi-hundred-ms scan that froze the UI on every History entry).
    // `session.time_updated` is the session's own last-activity timestamp.
    // Select the session's OWN directory, not just the joined project's
    // worktree: OpenCode buckets git sessions that had no remote/commit at
    // creation under the `global` project (worktree "/", empty name), so
    // `p.worktree` is "/" and basename("/") renders as "/". `s.directory` always
    // holds the real cwd for display. Project identity itself comes from the
    // recorded session-to-project mapping, not from the joined project table.
    // Exclude archived sessions: OpenCode archives a session (sets time_archived)
    // to hide it from its own list, so the dashboard mirrors that and shows only
    // live sessions. This also keeps archived rows out of the project-card session
    // counts, which read through this same path.
    let Ok(mut stmt) = conn.prepare(
        "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                COALESCE(s.directory, ''), s.time_updated AS last_activity
         FROM session s
         LEFT JOIN project p ON p.id = s.project_id
         WHERE s.time_archived IS NULL",
    ) else {
        return Vec::new();
    };

    // Look up the real `is_subagent` flag from Magic Context's session_meta
    // table for this harness. Sessions that have never been touched by the
    // plugin (very rare in practice for OpenCode sessions, since the plugin
    // tags every session on first prompt) default to `false`, matching the
    // "primary session" assumption.
    let subagent_map = load_subagent_map_for_harness(Harness::Opencode);
    let session_identities = load_session_identity_map();

    let rows = stmt.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: String = row.get(1)?;
        let project_name: String = row.get(2)?;
        let worktree: String = row.get(3)?;
        let directory: String = row.get(4)?;
        let last_activity_ms: i64 = row.get(5)?;
        // Prefer the session's real directory; fall back to the project worktree
        // only when the session row has no directory (legacy rows).
        let effective_dir = if directory.is_empty() {
            &worktree
        } else {
            &directory
        };
        let identity = lookup_session_identity(&session_identities, Harness::Opencode, &session_id);
        let is_subagent = subagent_map.get(&session_id).copied().unwrap_or(false);
        // Friendly label: the named project wins; otherwise the directory's
        // basename. Never show a bare "/" (the global-project worktree) when the
        // session actually ran in a real directory.
        let project_display = if !project_name.is_empty() {
            project_name
        } else {
            basename(effective_dir)
        };
        Ok(SessionRow {
            harness: Harness::Opencode,
            session_id,
            title,
            project_identity: identity,
            project_display,
            last_activity_ms,
            is_subagent,
        })
    });

    rows.map(|rows| {
        rows.flatten()
            .filter(|row| session_matches_filter(row, filter))
            .collect()
    })
    .unwrap_or_default()
}

pub fn list_pi_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    if filter.harness.is_some_and(|h| h != Harness::Pi) {
        return Vec::new();
    }
    let subagent_map = load_subagent_map_for_harness(Harness::Pi);
    let session_identities = load_session_identity_map();
    pi_sessions::scan_pi_compatible_session_dir()
        .into_iter()
        .map(|meta| {
            let project_identity =
                lookup_session_identity(&session_identities, Harness::Pi, &meta.session_id);
            let is_subagent = subagent_map.get(&meta.session_id).copied().unwrap_or(false);
            SessionRow {
                harness: Harness::Pi,
                session_id: meta.session_id,
                title: clean_pi_title(meta.session_name, &meta.first_message),
                project_identity,
                project_display: basename(&meta.cwd),
                last_activity_ms: meta.modified,
                is_subagent,
            }
        })
        .filter(|row| session_matches_filter(row, filter))
        .collect()
}

pub fn list_all_sessions(filter: SessionFilter) -> Vec<SessionRow> {
    let mut rows = Vec::new();
    rows.extend(list_opencode_sessions(&filter));
    rows.extend(list_pi_sessions(&filter));
    rows.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    rows
}

pub fn list_sessions_paged(filter: SessionFilter) -> PagedSessions {
    let rows = list_all_sessions(filter.clone());
    page_session_rows(rows, filter.offset, filter.limit)
}

fn page_session_rows(
    rows: Vec<SessionRow>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> PagedSessions {
    let total_usize = rows.len();
    let offset_usize = offset.unwrap_or(0) as usize;
    let limit_usize = limit.map(|value| value as usize).unwrap_or(total_usize);
    let paged_rows: Vec<SessionRow> = rows
        .into_iter()
        .skip(offset_usize)
        .take(limit_usize)
        .collect();
    let consumed = offset_usize.saturating_add(paged_rows.len());

    PagedSessions {
        rows: paged_rows,
        total: total_usize as u32,
        has_more: consumed < total_usize,
    }
}

fn session_matches_filter(row: &SessionRow, filter: &SessionFilter) -> bool {
    if let Some(identity) = filter.project_identity.as_deref() {
        if row.project_identity != identity {
            return false;
        }
    }
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let search = search.to_ascii_lowercase();
        let haystack = format!("{} {} {}", row.title, row.project_display, row.session_id)
            .to_ascii_lowercase();
        if !haystack.contains(&search) {
            return false;
        }
    }
    if let Some(want_subagent) = filter.is_subagent {
        if row.is_subagent != want_subagent {
            return false;
        }
    }
    true
}

/// Load `{session_id -> is_subagent}` from the Magic Context `session_meta`
/// table for the given harness. Returns an empty map on any DB error so a
/// missing cortexkit DB never crashes the dashboard — sessions then default
/// to `is_subagent=false` and the user simply sees no filtering until the
/// plugin's first run populates the table.
fn load_subagent_map_for_harness(harness: Harness) -> std::collections::HashMap<String, bool> {
    use std::collections::HashMap;
    let mut map: HashMap<String, bool> = HashMap::new();
    let Some(db_path) = resolve_db_path() else {
        return map;
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return map;
    };
    let harness_str = harness.as_str();
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, is_subagent
         FROM session_meta
         WHERE harness = ?1 AND is_subagent != 0",
    ) else {
        return map;
    };
    let rows = stmt.query_map([harness_str], |row| {
        let sid: String = row.get(0)?;
        let flag: i64 = row.get(1)?;
        Ok((sid, flag != 0))
    });
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
    }
    map
}

pub fn get_session_detail(
    conn: Option<&Connection>,
    harness: Harness,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    match harness {
        Harness::Opencode => get_opencode_session_detail(conn, session_id),
        Harness::Pi => Ok(get_pi_session_detail(conn, session_id)),
        Harness::ClaudeCode | Harness::Codex => Ok(None),
    }
}

/// Lazy message-list fetch for the Messages tab. Separated from
/// `get_session_detail` so opening a session doesn't pay the cost of
/// JSON-extracting role + aggregating `part` text for tens of thousands of
/// rows when the user lands on Compartments. Pi side reuses the mtime-cached
/// JSONL view, so a second call after `get_session_detail` is essentially free.
pub fn get_session_messages(
    harness: Harness,
    session_id: &str,
) -> Result<Vec<SessionMessageRow>, rusqlite::Error> {
    match harness {
        Harness::Opencode => {
            let Some(opencode_db_path) = resolve_opencode_db_path() else {
                return Ok(Vec::new());
            };
            let conn = open_readonly(&opencode_db_path)?;
            load_opencode_messages(&conn, session_id)
        }
        Harness::Pi => {
            let Some(path) = pi_sessions::find_pi_session_path(session_id) else {
                return Ok(Vec::new());
            };
            let Some(detail) = pi_sessions::read_pi_session_detail(&path) else {
                return Ok(Vec::new());
            };
            Ok(detail
                .messages
                .iter()
                .map(|message| SessionMessageRow {
                    message_id: message.entry_id.clone(),
                    timestamp_ms: message.timestamp_ms,
                    role: message.role.clone(),
                    text_preview: message.text_preview.clone(),
                    raw_json: message.raw_json.clone(),
                })
                .collect())
        }
        Harness::ClaudeCode | Harness::Codex => Ok(Vec::new()),
    }
}

pub fn get_opencode_session_detail(
    conn: Option<&Connection>,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    let Some(opencode_db_path) = resolve_opencode_db_path() else {
        return Ok(None);
    };
    let oc_conn = open_readonly(&opencode_db_path)?;
    let row = oc_conn.query_row(
        "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                COALESCE(s.directory, ''),
                COALESCE(json_object('id', s.id, 'title', s.title, 'directory', s.directory), '{}')
         FROM session s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?1",
        [session_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    );
    let Ok((session_id, title, project_name, worktree, directory, data_json)) = row else {
        return Ok(None);
    };
    // Prefer s.directory over p.worktree for identity/display: OpenCode buckets
    // git-repo sessions that had no remote/commit at creation under the `global`
    // project (worktree "/"), and the plugin keys identity off session.directory —
    // using worktree here would mis-resolve and show "/". Worktree is the fallback.
    let effective_dir = if directory.is_empty() {
        worktree.clone()
    } else {
        directory
    };

    // Cheap row counts for badge rendering. Both are O(rows-in-session) at
    // worst but use only INTEGER aggregates (no JSON extraction or part-table
    // join), so they're <20ms even for 37k-message sessions.
    let messages_count: i64 = oc_conn
        .query_row(
            "SELECT COUNT(*) FROM message WHERE session_id = ?1",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let cache_events_count: i64 = oc_conn
        .query_row(
            "SELECT COUNT(*) FROM message
             WHERE session_id = ?1
               AND json_extract(data, '$.role') = 'assistant'
               AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0",
            [&session_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let compartments = conn
        .map(|c| get_compartments(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let facts = conn
        .map(|c| get_session_facts(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let notes = conn
        .map(|c| get_session_notes(c, &session_id))
        .transpose()?
        .unwrap_or_default();
    let meta = conn
        .map(|c| get_session_meta(c, &session_id))
        .transpose()?
        .flatten();
    let token_breakdown = conn
        .map(|c| get_context_token_breakdown(c, &session_id))
        .transpose()?
        .flatten();

    let session_identities = load_session_identity_map();
    let project_identity =
        lookup_session_identity(&session_identities, Harness::Opencode, &session_id);

    Ok(Some(SessionDetail {
        harness: Harness::Opencode,
        session_id,
        title,
        project_identity,
        project_display: if project_name.is_empty() {
            basename(&effective_dir)
        } else {
            project_name
        },
        project_path: (!effective_dir.is_empty()).then_some(effective_dir),
        opencode_session_json: serde_json::from_str(&data_json).ok(),
        pi_jsonl_path: None,
        messages_count,
        cache_events_count,
        compartments,
        facts,
        notes,
        meta,
        token_breakdown,
        pi_compaction_entries: Vec::new(),
    }))
}

fn load_opencode_messages(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionMessageRow>, rusqlite::Error> {
    // OpenCode stores message metadata (role, time, agent, model) on the `message` table
    // but the actual text content lives in the separate `part` table joined by `message_id`.
    // Each part has its own JSON shape — `type=text` parts have a `text` field; other types
    // (`tool`, `step-start`, `step-finish`, `reasoning`, `file`) are not user-visible content.
    //
    // We aggregate text parts per message via GROUP_CONCAT for a single round-trip query
    // instead of N+1. Parts are ordered by `time_created` then `id` to preserve sequence.
    //
    // The `||` operator concatenates SQL strings; `||` with NULL produces NULL, so we wrap
    // json_extract in COALESCE to handle non-text parts (which return NULL for `$.text`).
    let mut stmt = conn.prepare(
        "SELECT
            CAST(m.id AS TEXT),
            m.time_created,
            COALESCE(CAST(json_extract(m.data, '$.role') AS TEXT), ''),
            m.data,
            COALESCE(
                (SELECT GROUP_CONCAT(json_extract(p.data, '$.text'), ' ')
                 FROM part p
                 WHERE p.message_id = m.id
                   AND json_extract(p.data, '$.type') = 'text'
                   AND json_extract(p.data, '$.text') IS NOT NULL),
                ''
            ) AS aggregated_text
         FROM message m
         WHERE m.session_id = ?1
         ORDER BY m.time_created ASC",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let raw_string: String = row.get(3)?;
        let raw_json: serde_json::Value = serde_json::from_str(&raw_string).unwrap_or_default();
        let aggregated_text: String = row.get(4)?;
        // Use aggregated parts text when present; fall back to legacy in-message content
        // (covers any future schema variants where text might live on the message row).
        let text_preview = if aggregated_text.is_empty() {
            preview_from_json(&raw_json)
        } else {
            normalize_preview(&aggregated_text)
        };
        Ok(SessionMessageRow {
            message_id: row.get(0)?,
            timestamp_ms: row.get(1)?,
            role: row.get(2)?,
            text_preview,
            raw_json,
        })
    })?;
    rows.collect()
}

/// Resolve a clean Pi session title.
///
/// Pi sessions migrated from OpenCode have a synthetic first user message that begins
/// with `<!-- migrated from OpenCode session ... -->`. When no explicit `session.name`
/// is present, that banner leaks through as the displayed title. Strip the comment +
/// boilerplate and use whatever real text follows it (often empty in practice). If
/// nothing useful remains, fall back to a short, readable placeholder.
fn clean_pi_title(session_name: Option<String>, first_message: &str) -> String {
    if let Some(name) = session_name.filter(|n| !n.trim().is_empty()) {
        return name;
    }
    let trimmed = first_message.trim_start();
    if !trimmed.starts_with("<!--") {
        return first_message.to_string();
    }
    // Strip a single `<!-- ... -->` HTML comment, then the migration boilerplate sentence
    // that the migrate command always appends after the comment.
    let after_comment = trimmed
        .find("-->")
        .map(|idx| trimmed[idx + 3..].trim_start().to_string())
        .unwrap_or_default();
    const MIGRATION_BOILERPLATE: &str = "The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.";
    let stripped = after_comment
        .strip_prefix(MIGRATION_BOILERPLATE)
        .map(|rest| rest.trim_start().to_string())
        .unwrap_or(after_comment);
    if stripped.trim().is_empty() {
        "Migrated session".to_string()
    } else {
        stripped
    }
}

/// Normalize and truncate text for preview: collapse whitespace, drop control characters,
/// and cap at 500 chars. Mirrors `preview_from_json` final pass for consistency.
fn normalize_preview(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

pub fn get_pi_session_detail(conn: Option<&Connection>, session_id: &str) -> Option<SessionDetail> {
    let path = pi_sessions::find_pi_session_path(session_id)?;
    let detail = pi_sessions::read_pi_session_detail(&path)?;
    let title = clean_pi_title(detail.meta.session_name.clone(), &detail.meta.first_message);

    // Counts come from the already-parsed (and mtime-cached) JSONL view, so
    // they're free. `cache_events_count` matches `get_pi_session_cache_events`
    // filter exactly: assistant messages with usage.total > 0.
    let messages_count = detail.messages.len() as i64;
    let cache_events_count = detail
        .messages
        .iter()
        .filter(|m| m.role == "assistant")
        .filter(|m| m.usage.as_ref().is_some_and(|u| u.total > 0))
        .count() as i64;

    let compartments = conn
        .and_then(|c| get_compartments(c, session_id).ok())
        .unwrap_or_default();
    let facts = conn
        .and_then(|c| get_session_facts(c, session_id).ok())
        .unwrap_or_default();
    let notes = conn
        .and_then(|c| get_session_notes(c, session_id).ok())
        .unwrap_or_default();
    let meta = conn
        .and_then(|c| get_session_meta(c, session_id).ok())
        .flatten();
    let token_breakdown = conn
        .and_then(|c| get_context_token_breakdown(c, session_id).ok())
        .flatten();
    let session_identities = load_session_identity_map();
    let project_identity = lookup_session_identity(&session_identities, Harness::Pi, session_id);
    Some(SessionDetail {
        harness: Harness::Pi,
        session_id: detail.meta.session_id.clone(),
        title,
        project_identity,
        project_display: basename(&detail.meta.cwd),
        project_path: (!detail.meta.cwd.is_empty()).then_some(detail.meta.cwd.clone()),
        opencode_session_json: None,
        pi_jsonl_path: Some(detail.meta.jsonl_path.to_string_lossy().to_string()),
        messages_count,
        cache_events_count,
        compartments,
        facts,
        notes,
        meta,
        token_breakdown,
        pi_compaction_entries: detail.compaction_entries,
    })
}

fn preview_from_json(value: &serde_json::Value) -> String {
    fn content_text(value: &serde_json::Value) -> String {
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        if let Some(parts) = value.as_array() {
            return parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .and_then(serde_json::Value::as_str)
                        .map(ToString::to_string)
                })
                .collect::<Vec<_>>()
                .join(" ");
        }
        String::new()
    }
    let text = value
        .get("content")
        .map(content_text)
        .or_else(|| value.get("parts").map(content_text))
        .unwrap_or_default();
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(500)
        .collect()
}

/// Look up OpenCode session titles and any project identities recorded for the
/// sessions. Missing rows return an empty identity so callers can degrade without
/// re-deriving it.
fn resolve_session_info(
    sessions: &[SessionSummary],
) -> std::collections::HashMap<String, (String, String)> {
    let mut result = HashMap::new();
    if sessions.is_empty() {
        return result;
    }

    let Some(opencode_db) = resolve_opencode_db_path() else {
        return result;
    };

    let conn = match open_readonly(&opencode_db) {
        Ok(c) => c,
        Err(_) => return result,
    };

    let mut stmt = match conn.prepare("SELECT s.id, COALESCE(s.title, '') FROM session s") {
        Ok(s) => s,
        Err(_) => return result,
    };
    let session_identities = load_session_identity_map();

    if let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) {
        for row in rows.flatten() {
            let (session_id, title) = row;
            let identity =
                lookup_session_identity(&session_identities, Harness::Opencode, &session_id);
            result.insert(session_id, (title, identity));
        }
    }

    result
}

pub fn get_compartments(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Compartment>, rusqlite::Error> {
    // v2 tiered compartments: read the paraphrase tiers (p1–p4), the
    // decay-rate `importance`, and `episode_type` directly off the row.
    // `legacy=1` rows predate the tiered format (p1–p4 NULL) and render
    // degraded on the frontend. `content` mirrors p1 for v2 rows.
    let mut stmt = conn.prepare(
        "SELECT c.id, c.session_id, c.sequence, c.start_message, c.end_message,
                c.start_message_id, c.end_message_id, c.title, c.content, c.created_at,
                c.importance, c.episode_type, c.p1, c.p2, c.p3, c.p4, c.legacy
         FROM compartments c
         WHERE c.session_id = ?1
         ORDER BY c.sequence DESC",
    )?;
    let mut compartments: Vec<Compartment> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            Ok(Compartment {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sequence: row.get(2)?,
                start_message: row.get(3)?,
                end_message: row.get(4)?,
                start_message_id: row.get(5)?,
                end_message_id: row.get(6)?,
                title: row.get(7)?,
                content: row.get(8)?,
                created_at: row.get(9)?,
                start_time: None,
                end_time: None,
                importance: row.get::<_, Option<i64>>(10)?.unwrap_or(50),
                episode_type: row.get(11)?,
                p1: row.get(12)?,
                p2: row.get(13)?,
                p3: row.get(14)?,
                p4: row.get(15)?,
                legacy: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // Resolve message timestamps from OpenCode DB
    if let Some(opencode_db_path) = resolve_opencode_db_path() {
        if let Ok(oc_conn) = open_readonly(&opencode_db_path) {
            for comp in compartments.iter_mut() {
                if let Some(ref start_id) = comp.start_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![start_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.start_time = ts;
                    }
                }
                if let Some(ref end_id) = comp.end_message_id {
                    if let Ok(ts) = oc_conn.query_row(
                        "SELECT time_created FROM message WHERE id = ?1",
                        rusqlite::params![end_id],
                        |row| row.get::<_, Option<i64>>(0),
                    ) {
                        comp.end_time = ts;
                    }
                }
            }
        }
    }

    Ok(compartments)
}

pub fn get_session_facts(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SessionFact>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, category, content, created_at, updated_at
         FROM session_facts WHERE session_id = ?1 ORDER BY category, created_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionFact {
            id: row.get(0)?,
            session_id: row.get(1)?,
            category: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

fn note_select_columns(conn: &Connection) -> Option<String> {
    if !table_exists(conn, "notes") {
        return None;
    }
    let required = [
        "id",
        "type",
        "status",
        "content",
        "session_id",
        "project_path",
        "surface_condition",
        "created_at",
        "updated_at",
    ];
    if !table_has_columns(conn, "notes", &required) {
        return None;
    }

    let late = |column: &str| {
        if table_has_column(conn, "notes", column) {
            column.to_string()
        } else {
            format!("NULL AS {column}")
        }
    };

    Some(format!(
        "id, type, status, content, session_id, project_path, surface_condition, \
         created_at, updated_at, {}, {}, {}",
        late("last_checked_at"),
        late("ready_at"),
        late("ready_reason")
    ))
}

fn map_note_row(row: &rusqlite::Row<'_>) -> Result<Note, rusqlite::Error> {
    Ok(Note {
        id: row.get(0)?,
        note_type: row.get(1)?,
        status: row.get(2)?,
        content: row.get(3)?,
        session_id: row.get(4)?,
        project_path: row.get(5)?,
        surface_condition: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        last_checked_at: row.get(9)?,
        ready_at: row.get(10)?,
        ready_reason: row.get(11)?,
    })
}

pub fn get_session_notes(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let Some(columns) = note_select_columns(conn) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT {columns}
         FROM notes WHERE session_id = ?1 AND type = 'session' AND status = 'active'
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map(rusqlite::params![session_id], map_note_row)?;
    rows.collect()
}

pub fn update_session_fact(
    conn: &mut Connection,
    fact_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    // Phase A: read the fact's owning session before opening the transaction.
    let session_id = lookup_session_fact_session_id(conn, fact_id)?;

    // Phase B: re-check the owner, mutate, and bump session_facts_version together.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_session_fact_session_unchanged(&tx, fact_id, &session_id)?;
    let affected = tx.execute(
        "UPDATE session_facts SET content = ?1, updated_at = ?2 WHERE id = ?3",
        params![content, now_millis(), fact_id],
    )?;
    if affected > 0 {
        bump_session_facts_version_for_session(&tx, &session_id)?;
    }
    tx.commit()?;
    Ok(affected)
}

pub fn delete_session_fact(conn: &mut Connection, fact_id: i64) -> Result<usize, rusqlite::Error> {
    // Phase A: read the fact's owning session before opening the transaction.
    let session_id = lookup_session_fact_session_id(conn, fact_id)?;

    // Phase B: re-check, bump before delete, then delete.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    verify_session_fact_session_unchanged(&tx, fact_id, &session_id)?;
    bump_session_facts_version_for_session(&tx, &session_id)?;
    let affected = tx.execute("DELETE FROM session_facts WHERE id = ?1", params![fact_id])?;
    tx.commit()?;
    Ok(affected)
}

pub fn update_note(
    conn: &Connection,
    note_id: i64,
    content: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![content, chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn delete_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM notes WHERE id = ?1",
        rusqlite::params![note_id],
    )
}

pub fn dismiss_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE notes SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), note_id],
    )
}

pub fn get_smart_notes(
    conn: &Connection,
    project_path: &str,
) -> Result<Vec<Note>, rusqlite::Error> {
    let Some(columns) = note_select_columns(conn) else {
        return Ok(Vec::new());
    };
    // Smart notes are stored under the resolved project identity; resolve the
    // filter to all stored paths that normalize to it so symlinked / legacy raw
    // paths still surface (mirrors the memories + key-files path resolution).
    let paths = resolve_paths_for_table_filter(conn, "notes", project_path)?;
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = build_in_placeholders(paths.len(), 1);
    let mut stmt = conn.prepare(&format!(
        "SELECT {columns}
         FROM notes
         WHERE project_path IN ({placeholders}) AND type = 'smart' AND status != 'dismissed'
         ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(paths.iter()), map_note_row)?;
    rows.collect()
}

pub fn get_session_meta(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SessionMetaRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT session_id, last_response_time, cache_ttl, counter, last_nudge_tokens,
                last_nudge_band, is_subagent, last_context_percentage, last_input_tokens,
                times_execute_threshold_reached, compartment_in_progress, system_prompt_hash,
                memory_block_count, COALESCE(new_work_tokens, 0), COALESCE(total_input_tokens, 0)
         FROM session_meta WHERE session_id = ?1",
    )?;
    let mut rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SessionMetaRow {
            session_id: row.get(0)?,
            last_response_time: row.get(1)?,
            cache_ttl: row.get(2)?,
            counter: row.get(3)?,
            last_nudge_tokens: row.get(4)?,
            last_nudge_band: row.get::<_, String>(5)?,
            is_subagent: row.get::<_, i64>(6)? != 0,
            last_context_percentage: row.get(7)?,
            last_input_tokens: row.get(8)?,
            times_execute_threshold_reached: row.get(9)?,
            compartment_in_progress: row.get::<_, i64>(10)? != 0,
            system_prompt_hash: row.get(11)?,
            memory_block_count: row.get(12)?,
            new_work_tokens: row.get(13)?,
            total_input_tokens: row.get(14)?,
        })
    })?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
}

pub fn get_subagent_invocations(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SubagentInvocation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, session_id, harness, subagent, task, provider_id, model_id,
                started_at, ended_at, status, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, error, parent_invocation_id
         FROM subagent_invocations
         WHERE session_id = ?1
         ORDER BY started_at DESC",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SubagentInvocation {
            id: row.get(0)?,
            session_id: row.get(1)?,
            harness: row.get(2)?,
            subagent: row.get(3)?,
            task: row.get(4)?,
            provider_id: row.get(5)?,
            model_id: row.get(6)?,
            started_at: row.get(7)?,
            ended_at: row.get(8)?,
            status: row.get(9)?,
            input_tokens: row.get(10)?,
            output_tokens: row.get(11)?,
            cache_read_tokens: row.get(12)?,
            cache_write_tokens: row.get(13)?,
            error: row.get(14)?,
            parent_invocation_id: row.get(15)?,
        })
    })?;
    rows.collect()
}

pub fn get_subagent_totals_by_subagent(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<SubagentTotals>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT subagent, COUNT(*), COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0)
         FROM subagent_invocations
         WHERE session_id = ?1
         GROUP BY subagent
         ORDER BY subagent",
    )?;
    let rows = stmt.query_map(rusqlite::params![session_id], |row| {
        Ok(SubagentTotals {
            subagent: row.get(0)?,
            invocations: row.get(1)?,
            total_input: row.get(2)?,
            total_output: row.get(3)?,
            total_cache_read: row.get(4)?,
            total_cache_write: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ── Dreamer queries ─────────────────────────────────────────

pub fn get_task_schedule_state(
    conn: &Connection,
) -> Result<Vec<TaskScheduleEntry>, rusqlite::Error> {
    if !table_exists(conn, "task_schedule_state") {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT project_path, task, last_run_at, next_due_at, last_status, last_error, retry_count
         FROM task_schedule_state ORDER BY project_path, task",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(TaskScheduleEntry {
            project_path: row.get(0)?,
            task: row.get(1)?,
            last_run_at: row.get(2)?,
            next_due_at: row.get(3)?,
            last_status: row.get(4)?,
            last_error: row.get(5)?,
            retry_count: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// One project's stored scheduler state, keyed by task. Used for last-run status
/// only — NOT for the displayed schedule (which comes from the effective config).
struct StoredTaskState {
    schedule: Option<String>,
    last_run_at: Option<i64>,
    next_due_at: Option<i64>,
    last_status: Option<String>,
    last_error: Option<String>,
    retry_count: i64,
}

/// Assemble the dreamer page's project-card view.
///
/// CRITICAL: the displayed schedule is the EFFECTIVE CONFIGURED schedule (global
/// config merged with any per-project override), NOT the per-project
/// task_schedule_state snapshot. The snapshot is written only when a project is
/// actively swept, so a dormant project carries a STALE schedule from whenever it
/// was last touched (e.g. an old 6-task `0 2 * * *` era) — which made inherited
/// projects show different task counts and stale "next" times. We render the
/// canonical task set with effective schedules (consistent across all inherited
/// projects) and use the snapshot purely for last-run status + a next-due that we
/// only trust when the snapshot's schedule still matches what we display.
pub fn get_dreamer_projects(conn: &Connection) -> Result<Vec<DreamerProject>, rusqlite::Error> {
    if !table_exists(conn, "task_schedule_state") {
        return Ok(Vec::new());
    }
    // 1. Stored scheduler state, grouped identity → task → state.
    let mut stmt = conn.prepare(
        "SELECT project_path, task, schedule, last_run_at, next_due_at, last_status, last_error, retry_count
         FROM task_schedule_state",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            StoredTaskState {
                schedule: row.get(2)?,
                last_run_at: row.get(3)?,
                next_due_at: row.get(4)?,
                last_status: row.get(5)?,
                last_error: row.get(6)?,
                retry_count: row.get(7)?,
            },
        ))
    })?;

    let mut state_by_identity: std::collections::BTreeMap<
        String,
        HashMap<String, StoredTaskState>,
    > = std::collections::BTreeMap::new();
    for row in rows {
        let (stored_path, task, state) = row?;
        let identity = normalize_stored_project_path(&stored_path);
        if identity.is_empty() {
            continue;
        }
        state_by_identity
            .entry(identity)
            .or_default()
            .insert(task, state);
    }

    // 2. identity → (label, worktree) via the same enumeration the picker uses.
    let identity_to_row: HashMap<String, ProjectRow> = enumerate_projects_filtered(None)
        .into_iter()
        .map(|row| (row.identity.clone(), row))
        .collect();

    // 2b. Reverse map identity → real directory from session.directory, so
    // `dir:<hash>` identities (non-git dirs OpenCode buckets under `global`,
    // invisible to the worktree-based enumeration) resolve to their real path.
    let dir_by_identity = session_directories_by_identity();

    // 3. Global (user) dreamer schedules — the baseline every project inherits.
    let global_schedules =
        crate::jsonc::read_dreamer_task_schedules(&crate::config::resolve_user_config_path());

    let projects = state_by_identity
        .into_iter()
        .map(|(identity, states)| {
            let row = identity_to_row.get(&identity);
            // Prefer the enumerated worktree; else the session.directory reverse
            // map (resolves dir:<hash>); keep only if it still exists on disk.
            let resolved_dir = row
                .map(|r| r.primary_path.clone())
                .filter(|p| !p.is_empty())
                .or_else(|| dir_by_identity.get(&identity).cloned())
                .filter(|p| std::path::Path::new(p).is_dir());
            let label = match row {
                Some(r) => r.display_name.clone(),
                // No enumerated row: name from the resolved directory's basename
                // (e.g. dir:c1a3… → "Work") so the user sees a real name, not a
                // hash. Fall back to a shortened identity only when unresolvable.
                None => match &resolved_dir {
                    Some(dir) => basename(dir),
                    None if identity.starts_with("git:") => {
                        format!("git:{}…", &identity[4..std::cmp::min(identity.len(), 14)])
                    }
                    None => identity.clone(),
                },
            };
            // A worktree is usable for config read/write only if it still exists.
            let worktree = resolved_dir.clone();
            let (config_path, has_project_config, project_schedules) = match &worktree {
                Some(wt) => {
                    let path = crate::config::resolve_project_config_path(wt);
                    let has = crate::jsonc::config_has_dreamer_block(&path);
                    let sched = if has {
                        crate::jsonc::read_dreamer_task_schedules(&path)
                    } else {
                        HashMap::new()
                    };
                    (Some(path.to_string_lossy().to_string()), has, sched)
                }
                None => (None, false, HashMap::new()),
            };

            // Effective schedule per canonical task: project override → global →
            // built-in default. Identical for every project that only inherits.
            let tasks = crate::config::CANONICAL_DREAM_TASKS
                .iter()
                .map(|&task| {
                    let effective = project_schedules
                        .get(task)
                        .or_else(|| global_schedules.get(task))
                        .cloned()
                        .unwrap_or_else(|| crate::config::default_task_schedule(task).to_string());
                    let state = states.get(task);
                    // Trust the stored next-due only when the snapshot still
                    // reflects the schedule we're displaying; otherwise it's a
                    // stale artifact of an old schedule → omit (no "next 5h ago").
                    let next_due_at = state.and_then(|s| {
                        if s.schedule.as_deref() == Some(effective.as_str()) {
                            s.next_due_at
                        } else {
                            None
                        }
                    });
                    DreamerProjectTask {
                        task: task.to_string(),
                        schedule: Some(effective),
                        last_run_at: state.and_then(|s| s.last_run_at),
                        next_due_at,
                        last_status: state.and_then(|s| s.last_status.clone()),
                        last_error: state.and_then(|s| s.last_error.clone()),
                        retry_count: state.map(|s| s.retry_count).unwrap_or(0),
                    }
                })
                .collect();

            DreamerProject {
                identity,
                label,
                worktree,
                config_path,
                has_project_config,
                tasks,
            }
        })
        .collect();

    Ok(projects)
}

pub fn get_dream_state(conn: &Connection) -> Result<Vec<DreamStateEntry>, rusqlite::Error> {
    // Degrade to empty on a pre-Dreamer-V2 DB (read-only dashboard, no migration).
    if !table_exists(conn, "dream_state") {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT key, value FROM dream_state")?;
    let rows = stmt.query_map([], |row| {
        Ok(DreamStateEntry {
            key: row.get(0)?,
            value: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn dream_run_select_columns(conn: &Connection) -> Option<String> {
    if !table_exists(conn, "dream_runs") {
        return None;
    }
    let memory_changes = if table_has_column(conn, "dream_runs", "memory_changes_json") {
        "memory_changes_json".to_string()
    } else {
        "NULL AS memory_changes_json".to_string()
    };
    let parent_session = if table_has_column(conn, "dream_runs", "parent_session_id") {
        "parent_session_id".to_string()
    } else {
        "NULL AS parent_session_id".to_string()
    };

    Some(format!(
        "id, project_path, started_at, finished_at, holder_id, tasks_json, \
         tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, \
         {memory_changes}, {parent_session}"
    ))
}

fn parse_dream_run_json<T: serde::de::DeserializeOwned>(
    value: &str,
    column_index: usize,
) -> Result<T, rusqlite::Error> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column_index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_dream_run_row(row: &rusqlite::Row<'_>) -> Result<DreamRun, rusqlite::Error> {
    let tasks_json_str: String = row.get(5)?;
    let memory_changes_json_str: Option<String> = row.get(10)?;

    Ok(DreamRun {
        id: row.get(0)?,
        project_path: row.get(1)?,
        started_at: row.get(2)?,
        finished_at: row.get(3)?,
        holder_id: row.get(4)?,
        tasks_json: parse_dream_run_json(&tasks_json_str, 5)?,
        tasks_succeeded: row.get(6)?,
        tasks_failed: row.get(7)?,
        smart_notes_surfaced: row.get(8)?,
        smart_notes_pending: row.get(9)?,
        memory_changes_json: memory_changes_json_str
            .as_deref()
            .map(|value| parse_dream_run_json(value, 10))
            .transpose()?,
        parent_session_id: row.get(11)?,
    })
}

type TokenRow = (String, i64, i64, i64, i64, i64);

fn map_token_row(row: &rusqlite::Row<'_>) -> Result<TokenRow, rusqlite::Error> {
    Ok((
        row.get::<_, Option<String>>(0)?.unwrap_or_default(),
        row.get::<_, i64>(1)?,
        row.get::<_, i64>(2)?,
        row.get::<_, i64>(3)?,
        row.get::<_, i64>(4)?,
        row.get::<_, i64>(5)?,
    ))
}

fn enrich_dream_run_tokens(conn: &Connection, run: &mut DreamRun) {
    let Ok(mut tasks) = serde_json::from_value::<Vec<serde_json::Value>>(run.tasks_json.clone())
    else {
        return;
    };
    // Scope the token join to THIS run's parent (dreamer child) session when we
    // have it (Dreamer v2): per-project leases let the same task name run
    // concurrently across projects, so a pure time-window + task join would
    // cross-sum overlapping runs' tokens. Legacy rows (parent_session_id NULL)
    // fall back to the time-window join — still correct for them because v1 ran
    // one project at a time so windows never overlapped.
    let rows_result = if let Some(parent) = run.parent_session_id.as_deref() {
        let Ok(mut stmt) = conn.prepare(
            "SELECT task, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0)
             FROM subagent_invocations
             WHERE subagent = 'dreamer' AND session_id = ?1
               AND started_at >= ?2 AND started_at <= ?3
             GROUP BY task",
        ) else {
            return;
        };
        stmt.query_map(
            rusqlite::params![parent, run.started_at, run.finished_at],
            map_token_row,
        )
        .map(|rows| rows.flatten().collect::<Vec<_>>())
    } else {
        let Ok(mut stmt) = conn.prepare(
            "SELECT task, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0),
                    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(cache_read_tokens), 0), COALESCE(SUM(cache_write_tokens), 0)
             FROM subagent_invocations
             WHERE subagent = 'dreamer' AND started_at >= ?1 AND started_at <= ?2
             GROUP BY task",
        ) else {
            return;
        };
        stmt.query_map(
            rusqlite::params![run.started_at, run.finished_at],
            map_token_row,
        )
        .map(|rows| rows.flatten().collect::<Vec<_>>())
    };
    let Ok(collected) = rows_result else {
        return;
    };
    let mut totals = std::collections::HashMap::new();
    for row in collected {
        totals.insert(row.0.clone(), row);
    }
    for task in &mut tasks {
        let Some(name) = task.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some((_, total, input, output, cache_read, cache_write)) = totals.get(name) {
            if let Some(obj) = task.as_object_mut() {
                obj.insert(
                    "tokens".to_string(),
                    serde_json::json!({
                        "total": total,
                        "input": input,
                        "output": output,
                        "cache_read": cache_read,
                        "cache_write": cache_write,
                    }),
                );
            }
        }
    }
    run.tasks_json = serde_json::Value::Array(tasks);
}

#[derive(Debug, Serialize, Clone)]
pub struct DreamMemoryChange {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub status: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct DreamRunMemoryDetail {
    pub written: Vec<DreamMemoryChange>,
    pub archived: Vec<DreamMemoryChange>,
    pub merged: Vec<DreamMemoryChange>,
}

/// Fetch a set of memories by id and project them into DreamMemoryChange rows,
/// preserving the order of `ids` (a memory may have been deleted since the run,
/// in which case it is silently dropped).
fn fetch_dream_memory_changes(
    conn: &Connection,
    ids: &[i64],
) -> Result<Vec<DreamMemoryChange>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let sql =
        format!("SELECT id, category, content, status FROM memories WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let mut by_id: std::collections::HashMap<i64, DreamMemoryChange> =
        std::collections::HashMap::new();
    let mut rows = stmt.query(params.as_slice()).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        by_id.insert(
            id,
            DreamMemoryChange {
                id,
                category: row.get(1).map_err(|e| e.to_string())?,
                content: row.get(2).map_err(|e| e.to_string())?,
                status: row.get(3).map_err(|e| e.to_string())?,
            },
        );
    }
    // Preserve input id order; skip ids no longer present.
    Ok(ids.iter().filter_map(|id| by_id.remove(id)).collect())
}

/// Build the exact memory-change detail from a run's stored `memory_changes_json`
/// id arrays. Returns `None` when the blob is absent or carries no id arrays
/// (older runs that recorded counts only) so the caller falls back to the
/// time-window reconstruction.
fn exact_dream_run_memory_changes(
    conn: &Connection,
    memory_changes_json: Option<&str>,
) -> Result<Option<DreamRunMemoryDetail>, String> {
    let Some(raw) = memory_changes_json else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Ok(None);
    };
    let ids = |key: &str| -> Vec<i64> {
        value
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|n| n.as_i64()).collect())
            .unwrap_or_default()
    };
    let written_ids = ids("writtenIds");
    let archived_ids = ids("archivedIds");
    let merged_ids = ids("mergedIds");
    // No id arrays at all → counts-only legacy row; let the caller approximate.
    if value.get("writtenIds").is_none()
        && value.get("archivedIds").is_none()
        && value.get("mergedIds").is_none()
    {
        return Ok(None);
    }
    Ok(Some(DreamRunMemoryDetail {
        written: fetch_dream_memory_changes(conn, &written_ids)?,
        archived: fetch_dream_memory_changes(conn, &archived_ids)?,
        merged: fetch_dream_memory_changes(conn, &merged_ids)?,
    }))
}

/// Reconstruct WHICH memories a dream run changed, by time-window over the run's
/// [started_at, finished_at]. `dream_runs` stores only counts (id-set diffs at
/// run time), so this is the retroactive view for existing runs:
///   - written  = memories created in the window
///   - merged   = memories superseded (merged into a canonical) in the window
///   - archived = memories archived (non-merged) in the window that pre-existed
///
/// Exact for `written`; archived/merged can differ by edge cases from the stored
/// count (e.g. a memory archived then un-archived). A future schema that records
/// the actual changed ids at run time would make this exact (see note).
pub fn get_dream_run_memory_changes(
    conn: &Connection,
    run_id: i64,
) -> Result<DreamRunMemoryDetail, String> {
    if !table_exists(conn, "dream_runs") {
        return Ok(DreamRunMemoryDetail::default());
    }
    let memory_changes_col = if table_has_column(conn, "dream_runs", "memory_changes_json") {
        "memory_changes_json"
    } else {
        "NULL AS memory_changes_json"
    };
    let (project_path, started_at, finished_at, memory_changes_json): (
        String,
        i64,
        i64,
        Option<String>,
    ) = conn
        .query_row(
            &format!(
                "SELECT project_path, started_at, finished_at, {memory_changes_col} FROM dream_runs WHERE id = ?1"
            ),
            rusqlite::params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    let paths = resolve_paths_for_memory_filter(conn, &project_path).map_err(|e| e.to_string())?;
    if paths.is_empty() {
        return Ok(DreamRunMemoryDetail::default());
    }

    // Exact path (#221): runs written by Dreamer v2 store the actual changed ids
    // in `memory_changes_json` ({writtenIds, archivedIds, mergedIds}). When
    // present, fetch those memories by id directly — exact, immune to the
    // time-window approximation. Older runs (counts only) fall through to the
    // time-window reconstruction below.
    if let Some(detail) = exact_dream_run_memory_changes(conn, memory_changes_json.as_deref())? {
        return Ok(detail);
    }
    let placeholders = paths.iter().map(|_| "?").collect::<Vec<_>>().join(", ");

    // One query covers all three buckets; classify per row in Rust so the
    // window/path predicates are written once.
    let sql = format!(
        "SELECT id, category, content, status, created_at, updated_at, superseded_by_memory_id
           FROM memories
          WHERE project_path IN ({placeholders})
            AND (
                  (created_at >= ?{c1} AND created_at <= ?{c2})
               OR (updated_at >= ?{c1} AND updated_at <= ?{c2})
            )",
        c1 = paths.len() + 1,
        c2 = paths.len() + 2,
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<&dyn rusqlite::ToSql> =
        paths.iter().map(|p| p as &dyn rusqlite::ToSql).collect();
    params.push(&started_at);
    params.push(&finished_at);

    let mut detail = DreamRunMemoryDetail::default();
    let mut rows = stmt.query(params.as_slice()).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: i64 = row.get(0).map_err(|e| e.to_string())?;
        let category: String = row.get(1).map_err(|e| e.to_string())?;
        let content: String = row.get(2).map_err(|e| e.to_string())?;
        let status: String = row.get(3).map_err(|e| e.to_string())?;
        let created_at: i64 = row.get(4).map_err(|e| e.to_string())?;
        let updated_at: i64 = row.get(5).map_err(|e| e.to_string())?;
        let superseded: Option<i64> = row.get(6).map_err(|e| e.to_string())?;
        let change = DreamMemoryChange {
            id,
            category,
            content,
            status,
        };
        let created_in_window = created_at >= started_at && created_at <= finished_at;
        let updated_in_window = updated_at >= started_at && updated_at <= finished_at;
        // Classify by FINAL status first so a memory created AND archived/merged
        // in the SAME run lands in the bucket matching the headline count. The
        // headline counts (runner.ts) are id-set diffs on the active set, so a
        // created-then-archived row is NOT net-"written" (it ended archived) and a
        // created-then-merged row is "merged" — checking created_in_window first
        // mislabeled both as written. Order: merged → archived → written.
        if superseded.is_some() && updated_in_window {
            detail.merged.push(change);
        } else if change.status == "archived" && updated_in_window {
            detail.archived.push(change);
        } else if created_in_window {
            detail.written.push(change);
        }
    }
    Ok(detail)
}

pub fn get_dream_runs(
    conn: &Connection,
    project_path: Option<&str>,
    limit: usize,
) -> Result<Vec<DreamRun>, String> {
    let Some(select_columns) = dream_run_select_columns(conn) else {
        return Ok(Vec::new());
    };
    let normalized_limit = std::cmp::max(limit, 1) as i64;
    let mut runs: Vec<DreamRun> = Vec::new();

    if let Some(project_path) = project_path {
        // Resolve identity-equivalent stored paths (git:/dir: forms, legacy raw
        // paths) so dream runs group the same way the Memories tab does — a
        // literal `WHERE project_path = ?` misses normalized-identity projects.
        let paths = resolve_paths_for_table_filter(conn, "dream_runs", project_path)
            .map_err(|e| e.to_string())?;
        let placeholders = build_in_placeholders(paths.len(), 1);
        let limit_idx = paths.len() + 1;
        let sql = format!(
            "SELECT {select_columns}
             FROM dream_runs
             WHERE project_path IN ({placeholders})
             ORDER BY finished_at DESC
             LIMIT ?{limit_idx}"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(paths.len() + 1);
        for p in &paths {
            params.push(p);
        }
        params.push(&normalized_limit);
        let mut rows = stmt.query(params.as_slice()).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {select_columns}
                 FROM dream_runs
                 ORDER BY finished_at DESC
                 LIMIT ?1"
            ))
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params![normalized_limit])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mapped = map_dream_run_row(row).map_err(|e| e.to_string())?;
            runs.push(mapped);
        }
    }

    for run in &mut runs {
        enrich_dream_run_tokens(conn, run);
    }
    Ok(runs)
}

// Dreamer v2 has no dashboard-writable queue: the per-task scheduler drains
// directly off task_schedule_state + keyed leases inside the running host, and
// the dashboard is DB-only (no live channel to trigger an in-process run).
// Manual runs go through `/ctx-dream` in the harness. The dashboard reflects
// schedule state read-only via get_task_schedule_state.

// ── User Memory types ───────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct UserMemory {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub promoted_at: Option<i64>,
    pub source_candidate_ids: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct UserMemoryCandidate {
    pub id: i64,
    pub content: String,
    pub session_id: String,
    pub source_compartment_start: Option<i64>,
    pub source_compartment_end: Option<i64>,
    pub created_at: i64,
}

// ── User Memory queries ──────────────────────────────────────

pub fn get_user_memories(
    conn: &Connection,
    status_filter: Option<&str>,
) -> Result<Vec<UserMemory>, rusqlite::Error> {
    let mut conditions = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("status = ?{}", params.len()));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = format!(
        "SELECT id, content, status, promoted_at, source_candidate_ids, created_at, updated_at
         FROM user_memories
         {}
         ORDER BY created_at DESC",
        where_clause
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        let source_candidate_ids: Option<String> = row.get(4)?;
        Ok(UserMemory {
            id: row.get(0)?,
            content: row.get(1)?,
            status: row.get(2)?,
            promoted_at: row.get(3)?,
            source_candidate_ids: source_candidate_ids
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok()),
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

pub fn get_user_memory_candidates(
    conn: &Connection,
) -> Result<Vec<UserMemoryCandidate>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, content, session_id, source_compartment_start, source_compartment_end, created_at
         FROM user_memory_candidates
         ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UserMemoryCandidate {
            id: row.get(0)?,
            content: row.get(1)?,
            session_id: row.get(2)?,
            source_compartment_start: row.get(3)?,
            source_compartment_end: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn dismiss_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE user_memories SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
        params![now_millis(), id],
    )?;
    if affected > 0 {
        bump_project_user_profile_version(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute("DELETE FROM user_memories WHERE id = ?1", params![id])?;
    if affected > 0 {
        bump_project_user_profile_version(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_user_memory_content(
    conn: &mut Connection,
    id: i64,
    content: &str,
) -> Result<(), rusqlite::Error> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let affected = tx.execute(
        "UPDATE user_memories SET content = ?1, updated_at = ?2 WHERE id = ?3",
        params![content, now_millis(), id],
    )?;
    // user_memories render into the cached m[0] <user-profile> block, so an
    // edit must bump the global user-profile version or running sessions keep
    // serving stale content (same invariant dismiss/delete rely on).
    if affected > 0 {
        bump_project_user_profile_version(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory_candidate(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

pub fn promote_user_memory_candidate(
    conn: &mut Connection,
    id: i64,
) -> Result<(), rusqlite::Error> {
    let now = now_millis();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let content: String = tx.query_row(
        "SELECT content FROM user_memory_candidates WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;

    tx.execute(
        "INSERT INTO user_memories
           (content, status, promoted_at, source_candidate_ids, created_at, updated_at)
         VALUES (?1, 'active', ?2, ?3, ?2, ?2)",
        params![content, now, format!("[{id}]")],
    )?;
    tx.execute(
        "DELETE FROM user_memory_candidates WHERE id = ?1",
        params![id],
    )?;
    bump_project_user_profile_version(&tx)?;

    tx.commit()?;
    Ok(())
}

// ── Database health ───────────────────────────────────────

pub fn get_db_health(db_path: &PathBuf) -> DbHealth {
    let exists = db_path.exists();
    let size_bytes: u64 = if exists {
        std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let wal_path = db_path.with_extension("db-wal");
    let wal_size_bytes: u64 = if wal_path.exists() {
        std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let mut table_counts = Vec::new();
    if exists {
        if let Ok(conn) = open_readonly(db_path) {
            let tables = [
                "memories",
                "compartments",
                "session_facts",
                "notes",
                "session_meta",
                "tags",
                "pending_ops",
                "task_schedule_state",
                "dream_state",
            ];
            for table in &tables {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |r| r.get(0))
                    .unwrap_or(0);
                table_counts.push(TableCount {
                    table_name: table.to_string(),
                    row_count: count,
                });
            }
        }
    }

    DbHealth {
        exists,
        path: db_path.to_string_lossy().to_string(),
        size_bytes,
        wal_size_bytes,
        table_counts,
    }
}

#[cfg(test)]
mod cache_session_list_query_tests {
    use super::*;

    fn cache_list_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open cache-list DB");
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX message_session_time ON message(session_id, time_created);",
        )
        .expect("create cache-list schema");
        conn
    }

    fn insert_session(conn: &Connection, id: &str, updated: i64) {
        conn.execute(
            "INSERT INTO session (id, title, time_updated, time_archived)
             VALUES (?1, NULL, ?2, NULL)",
            params![id, updated],
        )
        .expect("insert session");
    }

    fn insert_message(conn: &Connection, id: &str, session_id: &str, time: i64, total: i64) {
        let data = serde_json::json!({
            "role": if total > 0 { "assistant" } else { "tool" },
            "tokens": { "total": total }
        })
        .to_string();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, session_id, time, data],
        )
        .expect("insert message");
    }

    #[test]
    fn opencode_list_query_reads_only_paged_session_metadata() {
        let sql = RECENT_OPENCODE_CACHE_SESSIONS_SQL.to_ascii_lowercase();
        assert!(sql.contains("from session"));
        assert!(sql.contains("time_archived is null"));
        assert!(sql.contains("order by time_updated desc"));
        assert!(sql.contains("limit ?1 offset ?2"));
        assert!(!sql.contains("message"));
        assert!(!sql.contains("json_extract"));
    }

    #[test]
    fn recent_event_fast_path_is_session_scoped_and_bounded() {
        let sql = RECENT_OPENCODE_SESSION_MESSAGES_SQL.to_ascii_lowercase();
        assert!(sql.contains("session_id = ?1"));
        assert!(sql.contains("order by time_created desc"));
        assert!(sql.contains("limit ?2"));
        assert!(!sql.contains("json_extract"));
    }

    #[test]
    fn first_event_probe_is_session_scoped_and_bounded() {
        let sql = FIRST_OPENCODE_CACHE_EVENT_SQL.to_ascii_lowercase();
        assert!(sql.contains("session_id = ?1"));
        assert!(sql.contains("order by time_created asc"));
        assert!(sql.contains("limit 1"));
        assert!(!sql.contains("group by"));
    }

    #[test]
    fn cache_event_older_than_two_hundred_newer_rows_still_qualifies() {
        let conn = cache_list_db();
        insert_session(&conn, "heavy", 1_000);
        insert_message(&conn, "event", "heavy", 1, 10);
        for time in 2..=202 {
            insert_message(&conn, &format!("raw-{time}"), "heavy", time, 0);
        }

        let sessions = load_recent_opencode_cache_sessions_from_conn(&conn, 1, &HashSet::new());

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "heavy");
    }

    #[test]
    fn candidate_paging_finds_event_session_after_first_batch() {
        let conn = cache_list_db();
        for index in 0..4 {
            let id = format!("eventless-{index}");
            insert_session(&conn, &id, 100 - index);
            insert_message(&conn, &format!("message-{index}"), &id, 1, 0);
        }
        insert_session(&conn, "older-event", 1);
        insert_message(&conn, "older-event-message", "older-event", 1, 10);

        let sessions = load_recent_opencode_cache_sessions_from_conn(&conn, 1, &HashSet::new());

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "older-event");
    }

    #[test]
    fn hidden_subagents_do_not_consume_the_return_limit() {
        let conn = cache_list_db();
        let mut hidden = HashSet::new();
        for index in 0..50 {
            let id = format!("subagent-{index:02}");
            insert_session(&conn, &id, 100 - index);
            insert_message(&conn, &format!("event-{index}"), &id, 1, 10);
            hidden.insert(id);
        }
        insert_session(&conn, "primary", 1);
        insert_message(&conn, "primary-event", "primary", 1, 10);

        let sessions = load_recent_opencode_cache_sessions_from_conn(&conn, 1, &hidden);

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "primary");
    }
}

#[cfg(test)]
mod session_history_slice_tests {
    use super::extract_session_history_slice;

    #[test]
    fn extracts_inclusive_block() {
        let m0 = "<project-docs>x</project-docs>\n<session-history>\n## 1-2 · Example\nhi\n</session-history>\n<user-profile>y</user-profile>";
        let slice = extract_session_history_slice(m0).expect("slice present");
        assert!(slice.starts_with("<session-history>"));
        assert!(slice.ends_with("</session-history>"));
        assert!(slice.contains("## 1-2 · Example\nhi"));
        // Must NOT bleed into neighboring blocks.
        assert!(!slice.contains("project-docs"));
        assert!(!slice.contains("user-profile"));
    }

    #[test]
    fn returns_none_when_absent() {
        // Pre-materialization snapshot or a snapshot without compartments.
        assert!(extract_session_history_slice("<project-docs>only</project-docs>").is_none());
        assert!(extract_session_history_slice("").is_none());
    }

    #[test]
    fn returns_none_on_unclosed_block() {
        // Defensive: an open tag with no close must not panic or over-read.
        assert!(extract_session_history_slice("<session-history>oops no close").is_none());
    }
}

#[cfg(test)]
mod representative_dir_tests {
    use super::dir_is_better_representative;
    use std::fs;

    #[test]
    fn main_checkout_beats_worktree_regardless_of_path_length() {
        let tmp = std::env::temp_dir().join(format!("mc-repr-{}", std::process::id()));
        let main = tmp.join("aft");
        // A worktree path is LONGER than the main checkout here, AND we also test
        // the reverse so length never overrides the main-vs-worktree preference.
        let worktree = tmp.join("alfonso/worktrees/abc/bg_90a7f9ae");
        fs::create_dir_all(main.join(".git")).unwrap(); // main: .git is a DIR
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join(".git"), "gitdir: /somewhere\n").unwrap(); // worktree: .git is a FILE

        let main_s = main.to_string_lossy().to_string();
        let wt_s = worktree.to_string_lossy().to_string();

        // The main checkout should win as the representative, even though some
        // worktree paths could be shorter in other layouts.
        assert!(dir_is_better_representative(&main_s, &wt_s));
        assert!(!dir_is_better_representative(&wt_s, &main_s));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn within_same_kind_shorter_path_wins() {
        // Two non-main dirs (neither has a .git): the shorter (closer to root) wins.
        assert!(dir_is_better_representative("/a/repo", "/a/repo/subdir"));
        assert!(!dir_is_better_representative("/a/repo/subdir", "/a/repo"));
    }
}

#[cfg(test)]
mod session_identity_map_tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn context_db_path(data_home: &Path) -> PathBuf {
        data_home
            .join("cortexkit")
            .join("magic-context")
            .join("context.db")
    }

    fn opencode_db_path(data_home: &Path) -> PathBuf {
        data_home.join("opencode").join("opencode.db")
    }

    fn with_temp_data_home<T>(run: impl FnOnce(&Path) -> T) -> T {
        let _guard = env_lock();
        let data_home = tempfile::tempdir().expect("data home");
        let pi_root = tempfile::tempdir().expect("pi root");
        let old_xdg = std::env::var_os("XDG_DATA_HOME");
        std::env::set_var("XDG_DATA_HOME", data_home.path());
        crate::pi_sessions::clear_caches_for_tests();
        crate::pi_sessions::set_test_root_for_tests(pi_root.path().to_path_buf());

        let result = run(data_home.path());

        if let Some(old) = old_xdg {
            std::env::set_var("XDG_DATA_HOME", old);
        } else {
            std::env::remove_var("XDG_DATA_HOME");
        }
        crate::pi_sessions::clear_caches_for_tests();
        result
    }

    fn create_context_db(data_home: &Path, with_session_projects: bool) -> Connection {
        let path = context_db_path(data_home);
        std::fs::create_dir_all(path.parent().expect("context parent")).expect("context dirs");
        let conn = Connection::open(&path).expect("open context db");
        conn.execute_batch(
            "CREATE TABLE memories (
                project_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active'
            );",
        )
        .expect("create memories");
        if with_session_projects {
            conn.execute_batch(
                "CREATE TABLE session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (session_id, harness)
                );",
            )
            .expect("create session_projects");
        }
        conn
    }

    fn create_opencode_db(data_home: &Path) -> Connection {
        let path = opencode_db_path(data_home);
        std::fs::create_dir_all(path.parent().expect("opencode parent")).expect("opencode dirs");
        let conn = Connection::open(&path).expect("open opencode db");
        conn.execute_batch(
            "CREATE TABLE project (
                id TEXT PRIMARY KEY,
                name TEXT,
                worktree TEXT NOT NULL
            );
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                project_id TEXT,
                directory TEXT,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );",
        )
        .expect("create opencode schema");
        conn
    }

    fn insert_session_project(conn: &Connection, session_id: &str, harness: &str, identity: &str) {
        conn.execute(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at)
             VALUES (?1, ?2, ?3, 1000)",
            (session_id, harness, identity),
        )
        .expect("insert session project");
    }

    #[test]
    fn load_session_identity_map_reads_known_harnesses_and_skips_unknown() {
        with_temp_data_home(|data_home| {
            let conn = create_context_db(data_home, true);
            insert_session_project(&conn, "oc-1", "opencode", "git:oc-root");
            insert_session_project(&conn, "pi-1", "pi", "dir:pi-root");
            insert_session_project(&conn, "weird-1", "future", "git:future-root");
            drop(conn);

            let map = load_session_identity_map();
            assert_eq!(
                map.get(&(Harness::Opencode, "oc-1".to_string())),
                Some(&"git:oc-root".to_string())
            );
            assert_eq!(
                map.get(&(Harness::Pi, "pi-1".to_string())),
                Some(&"dir:pi-root".to_string())
            );
            assert_eq!(map.len(), 2, "unknown harness rows must be skipped");
        });
    }

    #[test]
    fn load_session_identity_map_missing_table_returns_empty() {
        with_temp_data_home(|data_home| {
            let conn = create_context_db(data_home, false);
            drop(conn);

            assert!(load_session_identity_map().is_empty());
        });
    }

    #[test]
    fn list_opencode_sessions_uses_recorded_identities_and_leaves_unmapped_empty() {
        with_temp_data_home(|data_home| {
            let context = create_context_db(data_home, true);
            insert_session_project(&context, "mapped", "opencode", "git:mapped-root");
            drop(context);

            let oc = create_opencode_db(data_home);
            oc.execute(
                "INSERT INTO project (id, name, worktree) VALUES ('p1', 'Project One', '/slow/share')",
                [],
            )
            .expect("insert project");
            oc.execute(
                "INSERT INTO session (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('mapped', 'Mapped session', 'p1', '/slow/share', 200, NULL)",
                [],
            )
            .expect("insert mapped session");
            oc.execute(
                "INSERT INTO session (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('unmapped', 'Old session', 'p1', '/other/share', 100, NULL)",
                [],
            )
            .expect("insert unmapped session");
            drop(oc);

            let rows = list_opencode_sessions(&SessionFilter::default());
            let mapped = rows
                .iter()
                .find(|row| row.session_id == "mapped")
                .expect("mapped row");
            assert_eq!(mapped.project_identity, "git:mapped-root");
            let unmapped = rows
                .iter()
                .find(|row| row.session_id == "unmapped")
                .expect("unmapped row");
            assert_eq!(unmapped.project_identity, "");
        });
    }

    #[test]
    fn get_project_cards_groups_mapped_sessions_and_uses_main_checkout_representative() {
        with_temp_data_home(|data_home| {
            let temp = tempfile::tempdir().expect("projects");
            let main = temp.path().join("main-checkout");
            let worktree = temp.path().join("worktrees").join("bg_123");
            let unmapped = temp.path().join("unmapped");
            std::fs::create_dir_all(main.join(".git")).expect("main git dir");
            std::fs::create_dir_all(&worktree).expect("worktree dir");
            std::fs::write(
                worktree.join(".git"),
                "gitdir: ../main/.git/worktrees/bg_123\n",
            )
            .expect("worktree git file");
            std::fs::create_dir_all(&unmapped).expect("unmapped dir");

            let context = create_context_db(data_home, true);
            insert_session_project(&context, "main-session", "opencode", "git:shared-root");
            insert_session_project(&context, "worktree-session", "opencode", "git:shared-root");
            context
                .execute(
                    "INSERT INTO memories (project_path, status) VALUES ('git:shared-root', 'active')",
                    [],
                )
                .expect("insert memory");

            let oc = create_opencode_db(data_home);
            oc.execute(
                "INSERT INTO project (id, name, worktree) VALUES ('main', 'Main Project', ?1)",
                [main.to_string_lossy().as_ref()],
            )
            .expect("insert main project");
            oc.execute(
                "INSERT INTO project (id, name, worktree) VALUES ('worktree', 'Worktree Project', ?1)",
                [worktree.to_string_lossy().as_ref()],
            )
            .expect("insert worktree project");
            oc.execute(
                "INSERT INTO project (id, name, worktree) VALUES ('unmapped', 'Unmapped Project', ?1)",
                [unmapped.to_string_lossy().as_ref()],
            )
            .expect("insert unmapped project");
            oc.execute(
                "INSERT INTO session (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('main-session', 'Main', 'main', ?1, 100, NULL)",
                [main.to_string_lossy().as_ref()],
            )
            .expect("insert main session");
            oc.execute(
                "INSERT INTO session (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('worktree-session', 'Worktree', 'worktree', ?1, 200, NULL)",
                [worktree.to_string_lossy().as_ref()],
            )
            .expect("insert worktree session");
            oc.execute(
                "INSERT INTO session (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('unmapped-session', 'Unmapped', 'unmapped', ?1, 300, NULL)",
                [unmapped.to_string_lossy().as_ref()],
            )
            .expect("insert unmapped session");
            drop(oc);

            let cards = get_project_cards(&context);
            assert_eq!(
                cards.len(),
                1,
                "unmapped sessions should not form project cards"
            );
            let card = &cards[0];
            assert_eq!(card.identity, "git:shared-root");
            assert_eq!(card.session_count, 2);
            assert_eq!(card.primary_path, main.to_string_lossy().to_string());
            assert_eq!(card.display_name, "main-checkout");
            assert_eq!(card.memory_count, 1);
        });
    }

    #[test]
    fn source_tree_does_not_spawn_git_for_identity_resolution() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let needle = ["Command::new(", "\"git\"", ")"].concat();
        let mut offenders = Vec::new();

        fn visit(dir: &Path, needle: &str, offenders: &mut Vec<PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read source dir") {
                let entry = entry.expect("dir entry");
                let path = entry.path();
                if path.is_dir() {
                    if path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name == "target")
                    {
                        continue;
                    }
                    visit(&path, needle, offenders);
                } else if path.extension().is_some_and(|ext| ext == "rs") {
                    let text = std::fs::read_to_string(&path).expect("read rust source");
                    if text.contains(needle) {
                        offenders.push(path);
                    }
                }
            }
        }

        visit(root, &needle, &mut offenders);
        assert!(
            offenders.is_empty(),
            "dashboard source must not spawn git: {offenders:?}"
        );
    }
}

#[cfg(test)]
mod list_sessions_paged_tests {
    use super::*;

    fn make_rows(count: usize) -> Vec<SessionRow> {
        (0..count)
            .map(|idx| SessionRow {
                harness: if idx % 2 == 0 {
                    Harness::Opencode
                } else {
                    Harness::Pi
                },
                session_id: format!("session-{idx:02}"),
                title: format!("Session {idx}"),
                project_identity: if idx % 3 == 0 {
                    "project-a"
                } else {
                    "project-b"
                }
                .to_string(),
                project_display: "Project".to_string(),
                last_activity_ms: (1000 - idx) as i64,
                is_subagent: idx % 4 == 0,
            })
            .collect()
    }

    #[test]
    fn paging_unset_returns_full_list_like_list_all_sessions() {
        let rows = make_rows(12);
        let paged = page_session_rows(rows.clone(), None, None);

        assert_eq!(paged.total, rows.len() as u32);
        assert!(!paged.has_more);
        assert_eq!(
            paged
                .rows
                .iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>(),
            rows.iter()
                .map(|row| row.session_id.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn paging_slices_rows_and_reports_has_more() {
        let rows = make_rows(12);
        let first = page_session_rows(rows.clone(), Some(0), Some(5));
        let second = page_session_rows(rows.clone(), Some(5), Some(5));
        let past_end = page_session_rows(rows, Some(20), Some(5));

        assert_eq!(first.rows.len(), 5);
        assert_eq!(first.rows[0].session_id, "session-00");
        assert!(first.has_more);
        assert_eq!(second.rows.len(), 5);
        assert_eq!(second.rows[0].session_id, "session-05");
        assert!(second.has_more);
        assert!(past_end.rows.is_empty());
        assert!(!past_end.has_more);
    }

    #[test]
    fn total_reflects_filtered_rows_before_paging() {
        let filter = SessionFilter {
            project_identity: Some("project-a".to_string()),
            ..SessionFilter::default()
        };
        let filtered: Vec<SessionRow> = make_rows(12)
            .into_iter()
            .filter(|row| session_matches_filter(row, &filter))
            .collect();
        let paged = page_session_rows(filtered, Some(0), Some(2));

        assert_eq!(paged.total, 4);
        assert_eq!(paged.rows.len(), 2);
        assert!(paged.has_more);
    }
}

#[cfg(test)]
mod clean_pi_title_tests {
    use super::clean_pi_title;

    #[test]
    fn explicit_session_name_wins() {
        assert_eq!(
            clean_pi_title(Some("My Session".into()), "anything"),
            "My Session"
        );
    }

    #[test]
    fn empty_session_name_is_ignored() {
        assert_eq!(clean_pi_title(Some("   ".into()), "fallback"), "fallback");
    }

    #[test]
    fn first_message_is_returned_when_no_banner() {
        assert_eq!(
            clean_pi_title(None, "implementing the new feature"),
            "implementing the new feature"
        );
    }

    #[test]
    fn migration_banner_is_stripped() {
        let banner = "<!-- migrated from OpenCode session ses_abc at 2026-05-01T16:48:44.508Z --> The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.";
        assert_eq!(clean_pi_title(None, banner), "Migrated session");
    }

    #[test]
    fn migration_banner_with_trailing_text_uses_trailing_text() {
        let banner = "<!-- migrated from OpenCode session ses_abc at 2026-05-01T16:48:44.508Z --> The following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment. Plan compaction-marker rollout";
        assert_eq!(
            clean_pi_title(None, banner),
            "Plan compaction-marker rollout"
        );
    }

    #[test]
    fn unknown_html_comment_is_passed_through_after_strip() {
        let text = "<!-- some other note --> real intent";
        assert_eq!(clean_pi_title(None, text), "real intent");
    }
}

#[cfg(test)]
mod load_messages_tests {
    use super::*;
    use rusqlite::Connection;

    /// Build a minimal in-memory OpenCode-shaped DB so we can exercise
    /// `load_opencode_messages` against the same schema OpenCode uses.
    fn make_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE TABLE part (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .expect("create schema");
        conn
    }

    fn insert_message(conn: &Connection, id: &str, role: &str, time: i64) {
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, 'ses_test', ?2, ?3)",
            (id, time, format!(r#"{{"role":"{}","time":{{"created":{}}}}}"#, role, time)),
        )
        .expect("insert message");
    }

    fn insert_part(conn: &Connection, id: &str, message_id: &str, time: i64, data: &str) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1, ?2, 'ses_test', ?3, ?3, ?4)",
            (id, message_id, time, data),
        )
        .expect("insert part");
    }

    #[test]
    fn aggregates_text_parts_into_preview() {
        let conn = make_test_db();
        insert_message(&conn, "msg_user_1", "user", 100);
        insert_part(
            &conn,
            "prt_1",
            "msg_user_1",
            100,
            r#"{"type":"text","text":"hello world"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].text_preview, "hello world");
    }

    #[test]
    fn concatenates_multiple_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_assistant_1", "assistant", 200);
        insert_part(
            &conn,
            "prt_a",
            "msg_assistant_1",
            200,
            r#"{"type":"text","text":"first chunk"}"#,
        );
        insert_part(
            &conn,
            "prt_b",
            "msg_assistant_1",
            201,
            r#"{"type":"text","text":"second chunk"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        // GROUP_CONCAT does not guarantee order across SQLite versions; both
        // halves must be present and joined by the configured separator.
        assert!(
            messages[0].text_preview.contains("first chunk"),
            "preview missing first chunk: {:?}",
            messages[0].text_preview
        );
        assert!(
            messages[0].text_preview.contains("second chunk"),
            "preview missing second chunk: {:?}",
            messages[0].text_preview
        );
    }

    #[test]
    fn skips_non_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_assistant_2", "assistant", 300);
        insert_part(
            &conn,
            "prt_tool",
            "msg_assistant_2",
            300,
            r#"{"type":"tool","callID":"x","tool":"read"}"#,
        );
        insert_part(
            &conn,
            "prt_step",
            "msg_assistant_2",
            301,
            r#"{"type":"step-finish","reason":"tool-calls"}"#,
        );
        insert_part(
            &conn,
            "prt_reasoning",
            "msg_assistant_2",
            302,
            r#"{"type":"reasoning","text":"internal thinking"}"#,
        );
        insert_part(
            &conn,
            "prt_text",
            "msg_assistant_2",
            303,
            r#"{"type":"text","text":"public answer"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview, "public answer");
        assert!(!messages[0].text_preview.contains("internal thinking"));
        assert!(!messages[0].text_preview.contains("read"));
    }

    #[test]
    fn empty_preview_when_no_text_parts() {
        let conn = make_test_db();
        insert_message(&conn, "msg_tool_only", "assistant", 400);
        insert_part(
            &conn,
            "prt_tool_only",
            "msg_tool_only",
            400,
            r#"{"type":"tool","callID":"x","tool":"read"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview, "");
    }

    #[test]
    fn orders_messages_by_time_created() {
        let conn = make_test_db();
        insert_message(&conn, "msg_late", "user", 1000);
        insert_message(&conn, "msg_early", "user", 100);
        insert_part(
            &conn,
            "prt_late",
            "msg_late",
            1000,
            r#"{"type":"text","text":"late"}"#,
        );
        insert_part(
            &conn,
            "prt_early",
            "msg_early",
            100,
            r#"{"type":"text","text":"early"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text_preview, "early");
        assert_eq!(messages[1].text_preview, "late");
    }

    #[test]
    fn normalizes_whitespace_and_truncates_to_500_chars() {
        let conn = make_test_db();
        let long_text = "x".repeat(700);
        insert_message(&conn, "msg_long", "user", 100);
        insert_part(
            &conn,
            "prt_long",
            "msg_long",
            100,
            &format!(r#"{{"type":"text","text":"{}"}}"#, long_text),
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text_preview.chars().count(), 500);
    }

    #[test]
    fn ignores_parts_belonging_to_other_messages() {
        let conn = make_test_db();
        insert_message(&conn, "msg_a", "user", 100);
        insert_message(&conn, "msg_b", "user", 200);
        insert_part(
            &conn,
            "prt_a",
            "msg_a",
            100,
            r#"{"type":"text","text":"text for a"}"#,
        );
        insert_part(
            &conn,
            "prt_b",
            "msg_b",
            200,
            r#"{"type":"text","text":"text for b"}"#,
        );

        let messages = load_opencode_messages(&conn, "ses_test").expect("load");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].text_preview, "text for a");
        assert_eq!(messages[1].text_preview, "text for b");
    }
}

#[cfg(test)]
mod cache_turn_tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn raw(
        harness: Harness,
        message_id: &str,
        session_id: &str,
        timestamp: i64,
        input: i64,
        cache_read: i64,
        cache_write: i64,
        total: i64,
        finish: Option<&str>,
    ) -> RawDbCacheEvent {
        RawDbCacheEvent {
            harness,
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            timestamp,
            input_tokens: input,
            cache_read,
            cache_write,
            total_tokens: total,
            agent: None,
            finish: finish.map(|s| s.to_string()),
            context_limit: None,
        }
    }

    fn turn_summary_event(events: &[DbCacheEvent]) -> Option<&DbCacheEvent> {
        fn rank(severity: &str) -> u8 {
            match severity {
                "full_bust" => 6,
                "bust" => 5,
                "warming" => 4,
                "warning" => 3,
                "stable" => 2,
                "info" => 1,
                _ => 0,
            }
        }

        events.iter().fold(None, |winner, event| match winner {
            None => Some(event),
            Some(current)
                if rank(event.severity.as_str()) > rank(current.severity.as_str())
                    || (rank(event.severity.as_str()) == rank(current.severity.as_str())
                        && event.timestamp >= current.timestamp) =>
            {
                Some(event)
            }
            Some(current) => Some(current),
        })
    }

    #[test]
    fn first_event_is_new_turn() {
        let rows = vec![raw(
            Harness::Opencode,
            "m1",
            "s1",
            100,
            10,
            80,
            10,
            100,
            Some("stop"),
        )];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 1);
        assert!(events[0].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
    }

    #[test]
    fn tool_calls_continuation_same_turn() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
        assert_eq!(events[1].turn_id, "m1");
    }

    #[test]
    fn stop_then_new_turn() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("stop"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                80,
                10,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(events[1].is_turn_start);
        assert_eq!(events[0].turn_id, "m1");
        assert_eq!(events[1].turn_id, "m2");
    }

    #[test]
    fn end_turn_acts_like_stop() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("end_turn"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert!(events[0].is_turn_start);
        assert!(events[1].is_turn_start);
    }

    #[test]
    fn interleaved_sessions_keep_per_session_turns() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "a1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "b1",
                "s2",
                101,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "a2",
                "s1",
                200,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
            raw(
                Harness::Opencode,
                "b2",
                "s2",
                201,
                10,
                85,
                5,
                100,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[0].turn_id, "a1");
        assert_eq!(events[1].turn_id, "b1");
        assert_eq!(events[2].turn_id, "a1");
        assert_eq!(events[3].turn_id, "b1");
    }

    #[test]
    fn multi_step_turn_worst_event_carries_its_own_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                200,
                100,
                310,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                0,
                0,
                10,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m3",
                "s1",
                300,
                10,
                10,
                0,
                20,
                Some("stop"),
            ),
        ];
        let decisions = HashMap::from([(
            (Harness::Opencode, "s1".to_string(), "m2".to_string()),
            TransformDecisionCause {
                decision: "execute".to_string(),
                materialize_reason: Some("pressure_refold".to_string()),
                emergency: false,
            },
        )]);

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        let winner = turn_summary_event(&events).expect("turn has events");
        assert_eq!(winner.message_id, "m2");
        assert_eq!(winner.severity, "full_bust");
        assert_eq!(winner.cause.as_deref(), Some("Compaction pressure"));
    }

    #[test]
    fn multi_step_turn_severity_tie_uses_newest_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                200,
                100,
                310,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                50,
                10,
                70,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m3",
                "s1",
                300,
                10,
                10,
                0,
                20,
                Some("stop"),
            ),
        ];
        let decisions = HashMap::from([
            (
                (Harness::Opencode, "s1".to_string(), "m2".to_string()),
                TransformDecisionCause {
                    decision: "execute".to_string(),
                    materialize_reason: Some("pressure_refold".to_string()),
                    emergency: false,
                },
            ),
            (
                (Harness::Opencode, "s1".to_string(), "m3".to_string()),
                TransformDecisionCause {
                    decision: "defer".to_string(),
                    materialize_reason: Some("explicit_flush".to_string()),
                    emergency: false,
                },
            ),
        ]);

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        assert_eq!(events[1].severity, "bust");
        assert_eq!(events[2].severity, "bust");
        let winner = turn_summary_event(&events).expect("turn has events");
        assert_eq!(winner.message_id, "m3");
        assert_eq!(winner.cause.as_deref(), Some("Manual flush"));
    }

    #[test]
    fn cache_read_drop_classifies_as_bust() {
        // m1: read=120, write=20 → expected next prefix = 120 + 20 = 140.
        // m2: read=50 → retention = 50/140 = 0.357 < 0.80 → bust (the cached
        //     prefix shrank). Previously this was masked as "warming"; a real
        //     prefix loss should read as a bust.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                120,
                20,
                150,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                50,
                90,
                150,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[1].severity, "bust");
    }

    #[test]
    fn cache_read_grows_as_expected_stays_stable() {
        // m1: read=135, write=5 → expected next prefix = 140.
        // m2: read=140 → retention = 1.0 → stable.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                135,
                5,
                150,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                140,
                5,
                155,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        // First-in-window with no baseline defaults benign.
        assert_eq!(events[0].severity, "stable");
        assert_eq!(events[1].severity, "stable");
    }

    #[test]
    fn big_input_does_not_false_warn() {
        // The core fix: a step that merely ADDS a large uncached input (a 30k
        // file read / tool result) is NOT a cache bust. m1 establishes a 200k
        // prefix; m2 reads a 30k file (input jumps) but the cached prefix holds.
        // Old single-row ratio: 201000/(30000+201000+1000)=0.866 → WARNING.
        // New cross-step retention: 201000/(200000+1000)=1.0 → STABLE.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                30_000,
                201_000,
                1_000,
                232_200,
                Some("tool-calls"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[1].severity, "stable");
    }

    #[test]
    fn cache_read_to_zero_is_full_bust() {
        // m1 established a prefix; m2 reads nothing from cache → full_bust.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[1].severity, "full_bust");
    }

    #[test]
    fn transform_decision_cause_mapping_uses_canonical_reasons() {
        assert_eq!(
            transform_decision_cause(Some(&TransformDecisionCause {
                decision: "execute".to_string(),
                materialize_reason: None,
                emergency: false,
            }))
            .as_deref(),
            Some("Execute pass (reclaimed tool output)")
        );
        assert_eq!(
            transform_decision_cause(Some(&TransformDecisionCause {
                decision: "defer".to_string(),
                materialize_reason: Some("system_hash".to_string()),
                emergency: false,
            }))
            .as_deref(),
            Some("System prompt change")
        );
        assert_eq!(
            transform_decision_cause(Some(&TransformDecisionCause {
                decision: "execute".to_string(),
                materialize_reason: Some("pressure_refold".to_string()),
                emergency: false,
            }))
            .as_deref(),
            Some("Compaction pressure")
        );
        assert_eq!(
            transform_decision_cause(Some(&TransformDecisionCause {
                decision: "defer".to_string(),
                materialize_reason: None,
                emergency: true,
            }))
            .as_deref(),
            Some("Compaction pressure")
        );
        assert_eq!(transform_decision_cause(None), None);
    }

    #[test]
    fn message_id_join_picks_matching_transform_decision_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let mut decisions = HashMap::new();
        decisions.insert(
            (Harness::Opencode, "s1".to_string(), "m2".to_string()),
            TransformDecisionCause {
                decision: "defer".to_string(),
                materialize_reason: Some("explicit_flush".to_string()),
                emergency: false,
            },
        );

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(events[1].cause.as_deref(), Some("Manual flush"));
    }

    #[test]
    fn rust_module_reasons_are_labeled_and_unknown_reasons_are_preserved() {
        for (reason, label) in [
            ("m1_delta", "M1 delta"),
            ("ttl_expiry", "TTL expiry"),
            ("epoch_change", "Epoch change"),
            ("coverage_fold", "Coverage fold"),
            ("profile_transition", "Profile transition"),
        ] {
            let cause = TransformDecisionCause {
                decision: "execute".to_string(),
                materialize_reason: Some(reason.to_string()),
                emergency: false,
            };
            assert_eq!(
                transform_decision_cause(Some(&cause)).as_deref(),
                Some(label)
            );
        }

        let unknown = TransformDecisionCause {
            decision: "execute".to_string(),
            materialize_reason: Some("future_module_reason".to_string()),
            emergency: false,
        };
        assert_eq!(
            transform_decision_cause(Some(&unknown)).as_deref(),
            Some("future_module_reason")
        );
    }

    #[test]
    fn bust_without_transform_decision_is_unattributed() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events_with_decisions(rows, true, Some(HashMap::new()));
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            events[1].cause.as_deref(),
            Some(UNATTRIBUTED_CACHE_BUST_CAUSE)
        );
    }

    #[test]
    fn missing_transform_decision_after_mc_activity_is_unattributed() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let mut decisions = HashMap::new();
        decisions.insert(
            (Harness::Opencode, "s1".to_string(), "m1".to_string()),
            TransformDecisionCause {
                decision: "defer".to_string(),
                materialize_reason: None,
                emergency: false,
            },
        );

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            events[1].cause.as_deref(),
            Some(UNATTRIBUTED_CACHE_BUST_CAUSE)
        );
    }

    #[test]
    fn steady_state_missing_transform_decision_has_no_alarm_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                10,
                135,
                5,
                150,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                10,
                140,
                5,
                155,
                Some("stop"),
            ),
        ];
        let decisions = HashMap::from([(
            (Harness::Opencode, "s1".to_string(), "m1".to_string()),
            TransformDecisionCause {
                decision: "defer".to_string(),
                materialize_reason: None,
                emergency: false,
            },
        )]);

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        assert_eq!(events[1].severity, "stable");
        assert_eq!(events[1].cause, None);
    }

    #[test]
    fn recorded_transform_error_is_fail_open_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let decisions = HashMap::from([(
            (Harness::Opencode, "s1".to_string(), "m2".to_string()),
            TransformDecisionCause {
                decision: "error".to_string(),
                materialize_reason: None,
                emergency: false,
            },
        )]);

        let events = build_db_cache_events_with_decisions(rows, true, Some(decisions));
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            events[1].cause.as_deref(),
            Some(MC_TRANSFORM_FAILED_OPEN_CAUSE)
        );
    }

    #[test]
    fn session_transform_error_is_fail_open_cause() {
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                200_000,
                1_000,
                201_102,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                205_000,
                0,
                0,
                205_500,
                Some("stop"),
            ),
        ];
        let failures = HashSet::from([(Harness::Opencode, "s1".to_string())]);

        let events = build_db_cache_events_with_attribution(
            rows,
            true,
            Some(HashMap::new()),
            Some(failures),
        );
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            events[1].cause.as_deref(),
            Some(MC_TRANSFORM_FAILED_OPEN_CAUSE)
        );
    }

    #[test]
    fn transform_failure_loader_requires_a_recorded_error() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                last_transform_error TEXT
            );
            INSERT INTO session_meta (session_id, harness, last_transform_error) VALUES
                ('s1', 'opencode', 'transform failed'),
                ('s2', 'opencode', ''),
                ('s3', 'opencode', '   ');",
        )
        .unwrap();
        let keys = HashSet::from([
            (Harness::Opencode, "s1".to_string()),
            (Harness::Opencode, "s2".to_string()),
            (Harness::Opencode, "s3".to_string()),
        ]);

        let failures = load_transform_failure_sessions_from_conn(&conn, &keys);

        assert_eq!(
            failures,
            HashSet::from([(Harness::Opencode, "s1".to_string())])
        );
    }

    #[test]
    fn missing_transform_decisions_table_is_graceful() {
        let conn = Connection::open_in_memory().unwrap();
        let keys = HashSet::from([(Harness::Opencode, "s1".to_string())]);
        let decisions = load_transform_decision_causes_from_conn(&conn, &keys);
        assert!(decisions.is_empty());
    }

    #[test]
    fn prompt_shrink_marks_drop() {
        // m1: large prompt (~250k). m2: prompt drops by >15k → MC reclaim → is_drop.
        // m3: prompt grows again → not a drop.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2,
                250_000,
                1_000,
                251_500,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                2,
                150_000,
                500,
                151_000,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m3",
                "s1",
                300,
                2,
                151_000,
                400,
                152_000,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert!(
            !events[0].is_drop,
            "first step has no previous to drop from"
        );
        assert!(events[1].is_drop, "prompt shrank ~100k → drop");
        assert!(!events[2].is_drop, "prompt grew → not a drop");
    }

    #[test]
    fn session_with_no_cache_reporting_is_unknown() {
        // A provider that never reports cache_read (e.g. ollama-cloud) must not
        // be classified as a string of busts — every row is UNKNOWN.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                60_000,
                0,
                0,
                60_500,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                80_000,
                0,
                0,
                80_500,
                Some("stop"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[0].severity, "unknown");
        assert_eq!(events[1].severity, "unknown");
    }

    #[test]
    fn non_anthropic_growth_uses_input_plus_output() {
        // No cache_write (write=0) → expected growth = prev.input + prev.output.
        // m1: read=100000, input=2000, output=500 (total=102500), write=0.
        //     expected next prefix = 100000 + 2000 + 500 = 102500.
        // m2: read=102500 → retention = 1.0 → stable.
        let rows = vec![
            raw(
                Harness::Opencode,
                "m1",
                "s1",
                100,
                2_000,
                100_000,
                0,
                102_500,
                Some("tool-calls"),
            ),
            raw(
                Harness::Opencode,
                "m2",
                "s1",
                200,
                1_000,
                102_500,
                0,
                103_700,
                Some("tool-calls"),
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[1].severity, "stable");
    }

    #[test]
    fn pi_stop_reason_extracted_as_finish() {
        // build_db_cache_events is harness-agnostic for grouping;
        // just verify Pi rows with stop_reason are processed correctly.
        let rows = vec![
            raw(
                Harness::Pi,
                "p1",
                "s1",
                100,
                10,
                80,
                10,
                100,
                Some("tool-calls"),
            ),
            raw(Harness::Pi, "p2", "s1", 200, 10, 80, 10, 100, Some("stop")),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert_eq!(events[1].turn_id, "p1");
    }

    #[test]
    fn codex_no_write_variant_uses_read_ratio() {
        let rows = vec![
            raw(
                Harness::Codex,
                "c1",
                "codex-session",
                100,
                1_000,
                0,
                0,
                1_100,
                None,
            ),
            raw(
                Harness::Codex,
                "c2",
                "codex-session",
                200,
                150,
                850,
                0,
                1_050,
                None,
            ),
            raw(
                Harness::Codex,
                "c3",
                "codex-session",
                300,
                500,
                500,
                0,
                1_050,
                None,
            ),
        ];
        let events = build_db_cache_events(rows, false);
        assert_eq!(events[0].severity, "stable");
        assert_eq!(events[1].severity, "warning");
        assert!((events[1].hit_ratio - 0.85).abs() < f64::EPSILON);
        assert_eq!(events[2].severity, "bust");
        assert!((events[2].hit_ratio - 0.5).abs() < f64::EPSILON);
        assert_eq!(events[2].cache_write, 0);
    }
}

#[cfg(test)]
mod managed_cache_tests {
    use super::*;

    #[test]
    fn managed_detection_matches_exact_and_composite_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute(
                "CREATE TABLE mc_cache_state (session_id TEXT PRIMARY KEY)",
                [],
            )
            .unwrap();
            // Composite managed keys store the wire session id first, followed by
            // U+241F and subagent/epoch parts. Matching by this prefix folds those
            // rows back onto the visible Claude Code session.
            conn.execute(
                "INSERT INTO mc_cache_state (session_id) VALUES (?1), (?2), (?3), (?4)",
                params![
                    "cc-exact",
                    "cc-composite␟agent␟1",
                    "cc-other-suffix",
                    "codex-exact",
                ],
            )
            .unwrap();
        }

        let keys = HashSet::from([
            (Harness::ClaudeCode, "cc-exact".to_string()),
            (Harness::ClaudeCode, "cc-composite".to_string()),
            (Harness::ClaudeCode, "cc-other".to_string()),
            (Harness::Codex, "codex-exact".to_string()),
            (Harness::Opencode, "oc-session".to_string()),
        ]);
        let managed = load_managed_cache_sessions_from_path(&path, &keys);
        assert!(managed.contains(&(Harness::ClaudeCode, "cc-exact".to_string())));
        assert!(managed.contains(&(Harness::ClaudeCode, "cc-composite".to_string())));
        assert!(!managed.contains(&(Harness::ClaudeCode, "cc-other".to_string())));
        assert!(managed.contains(&(Harness::Codex, "codex-exact".to_string())));
        assert!(!managed.contains(&(Harness::Opencode, "oc-session".to_string())));
    }

    #[test]
    fn managed_detection_absent_store_degrades_to_unmanaged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-store.db");
        let keys = HashSet::from([(Harness::ClaudeCode, "cc-session".to_string())]);
        assert!(load_managed_cache_sessions_from_path(&path, &keys).is_empty());
    }
}

#[cfg(test)]
mod get_session_cache_events_by_turn_count_tests {
    use super::*;

    fn event(
        message_id: &str,
        session_id: &str,
        timestamp: i64,
        is_turn_start: bool,
    ) -> DbCacheEvent {
        DbCacheEvent {
            harness: Harness::Opencode,
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            timestamp,
            input_tokens: 10,
            cache_read: 80,
            cache_write: 10,
            total_tokens: 100,
            hit_ratio: 0.8,
            severity: "stable".to_string(),
            cause: None,
            agent: None,
            finish: Some("stop".to_string()),
            turn_id: String::new(),
            is_turn_start,
            context_limit: 0,
            context_limit_estimated: false,
            is_drop: false,
        }
    }

    #[test]
    fn empty_session_returns_empty() {
        let result = trim_events_to_turns(Vec::new(), 3);
        assert!(result.is_empty());
    }

    #[test]
    fn fewer_turns_than_target_returns_all() {
        // 2 turns, target=10 → all events returned
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, true),
            event("m4", "s1", 400, false),
        ];
        let result = trim_events_to_turns(events.clone(), 10);
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].message_id, "m1");
        assert_eq!(result[3].message_id, "m4");
    }

    #[test]
    fn trims_oldest_turns_when_over_target() {
        // 5 turns, target=3 → keep last 3 turns (turns 3-5 = m5-m12)
        let events = vec![
            event("m1", "s1", 100, true),    // turn 1 start
            event("m2", "s1", 200, false),   // turn 1 cont
            event("m3", "s1", 300, true),    // turn 2 start
            event("m4", "s1", 400, false),   // turn 2 cont
            event("m5", "s1", 500, true),    // turn 3 start
            event("m6", "s1", 600, false),   // turn 3 cont
            event("m7", "s1", 700, true),    // turn 4 start
            event("m8", "s1", 800, false),   // turn 4 cont
            event("m9", "s1", 900, true),    // turn 5 start
            event("m10", "s1", 1000, false), // turn 5 cont
            event("m11", "s1", 1100, false), // turn 5 cont
            event("m12", "s1", 1200, false), // turn 5 cont
        ];
        let result = trim_events_to_turns(events, 3);
        assert_eq!(result.len(), 8); // m5-m12
        assert_eq!(result[0].message_id, "m5");
        assert_eq!(result[7].message_id, "m12");
        // Verify turn starts in the trimmed result
        assert!(result[0].is_turn_start); // m5 (turn 3 start)
        assert!(!result[1].is_turn_start); // m6
        assert!(result[2].is_turn_start); // m7 (turn 4 start)
        assert!(!result[3].is_turn_start); // m8
        assert!(result[4].is_turn_start); // m9 (turn 5 start)
    }

    #[test]
    fn exact_target_turns_returns_all() {
        // 3 turns, target=3 → all events returned
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, true),
            event("m4", "s1", 400, false),
            event("m5", "s1", 500, true),
            event("m6", "s1", 600, false),
        ];
        let result = trim_events_to_turns(events.clone(), 3);
        assert_eq!(result.len(), 6);
    }

    #[test]
    fn one_long_turn_returns_all() {
        // 50 events all in one turn, target=5 → all 50 returned as one turn
        let events: Vec<DbCacheEvent> = (0..50)
            .map(|i| event(&format!("m{i}"), "s1", 100 + i as i64 * 10, i == 0))
            .collect();
        let result = trim_events_to_turns(events.clone(), 5);
        assert_eq!(result.len(), 50);
        // Only the first event should be a turn start
        assert!(result[0].is_turn_start);
        for e in result.iter().skip(1) {
            assert!(!e.is_turn_start);
        }
    }

    #[test]
    fn single_turn_target_one_returns_all() {
        let events = vec![
            event("m1", "s1", 100, true),
            event("m2", "s1", 200, false),
            event("m3", "s1", 300, false),
        ];
        let result = trim_events_to_turns(events.clone(), 1);
        assert_eq!(result.len(), 3);
        assert!(result[0].is_turn_start);
    }

    #[test]
    fn target_zero_returns_empty() {
        let events = vec![event("m1", "s1", 100, true), event("m2", "s1", 200, false)];
        let result = trim_events_to_turns(events, 0);
        assert!(result.is_empty());
    }
}

#[cfg(test)]
mod memory_project_filter_tests {
    //! Issue #87: the dashboard Memories tab project filter returned zero
    //! results when any project was selected because the frontend sent the
    //! resolved project *identity* (`git:<hash>` / `dir:<md5-12>`) while
    //! `get_memories` / `get_memory_stats` filtered with `project_path = ?`
    //! against raw filesystem paths stored in the `memories` table.
    //!
    //! These tests cover the helper that maps identity-shaped stored paths and
    //! legacy raw paths to the values that should be queried, plus the end-to-end
    //! identity-filter behavior of `get_memories` and `get_memory_stats`.
    use super::*;
    use rusqlite::Connection;

    /// Build a minimal in-memory Magic Context-shaped DB with just enough of
    /// the `memories` + `memory_embeddings` + `memories_fts` surface that
    /// `get_memories` and `get_memory_stats` can run end-to-end.
    fn make_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                normalized_hash TEXT,
                source_session_id TEXT,
                source_type TEXT,
                seen_count INTEGER DEFAULT 1,
                retrieval_count INTEGER DEFAULT 0,
                first_seen_at INTEGER,
                created_at INTEGER,
                updated_at INTEGER,
                last_seen_at INTEGER,
                last_retrieved_at INTEGER,
                status TEXT NOT NULL DEFAULT 'active',
                expires_at INTEGER,
                verification_status TEXT,
                verified_at INTEGER,
                superseded_by_memory_id INTEGER,
                merged_from TEXT,
                metadata_json TEXT
            );
            CREATE TABLE memory_embeddings (
                memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
                vector BLOB NOT NULL,
                model_id TEXT
            );
            CREATE VIRTUAL TABLE memories_fts USING fts5(
                content, category, content='memories', content_rowid='id'
            );",
        )
        .expect("create memory schema");
        conn
    }

    fn insert_memory(conn: &Connection, project_path: &str, category: &str, status: &str) -> i64 {
        // `map_memory_row` expects every non-Option Memory field to be
        // present and well-typed, so the test inserts must populate them:
        // normalized_hash, source_type, seen_count, retrieval_count,
        // first_seen_at, last_seen_at, verification_status. Nullable
        // columns (source_session_id, expires_at, etc.) are intentionally
        // left default-NULL.
        let content = format!("memory in {project_path} / {category}");
        let normalized_hash = format!(
            "{:x}",
            md5::compute(format!("{project_path}|{category}|{content}").as_bytes())
        );
        conn.execute(
            "INSERT INTO memories
                (project_path, category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     ?5, 1000, 1000)",
            (project_path, category, content, normalized_hash, status),
        )
        .expect("insert memory");
        conn.last_insert_rowid()
    }

    /// Raw legacy paths degrade to a deterministic `dir:<md5-12>` identity.
    fn stable_dir_identity(path: &str) -> String {
        normalize_stored_project_path(path)
    }

    #[test]
    fn resolve_paths_returns_all_paths_sharing_identity() {
        // A legacy raw path and its deterministic fallback identity must refer
        // to the same stored memory rows.
        let conn = make_memory_db();

        // Two distinct memories under the same project_path (the realistic
        // case where one path accumulates many memories over time).
        insert_memory(
            &conn,
            "/tmp/test-proj-1",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(&conn, "/tmp/test-proj-1", "CONSTRAINTS", "active");

        // A memory under a different path that must NOT be returned when we
        // filter by the first path's identity.
        insert_memory(
            &conn,
            "/tmp/test-proj-2",
            "ARCHITECTURE_DECISIONS",
            "active",
        );

        let identity = stable_dir_identity("/tmp/test-proj-1");
        let paths = resolve_paths_for_memory_filter(&conn, &identity).expect("resolve paths");

        assert_eq!(
            paths,
            vec!["/tmp/test-proj-1".to_string()],
            "expected exactly the matching project_path, got {paths:?}"
        );
    }

    #[test]
    fn resolve_paths_falls_back_to_raw_value_when_no_match() {
        // Backward compatibility: older dashboard builds (or external
        // callers) might send a raw path. If no stored memories resolve to
        // it as an identity, we fall back to filtering by that single value
        // — matching pre-fix behavior so legacy clients still work.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/somewhere", "X", "active");

        let paths = resolve_paths_for_memory_filter(&conn, "/tmp/legacy-raw-path-filter")
            .expect("resolve paths");

        assert_eq!(paths, vec!["/tmp/legacy-raw-path-filter".to_string()]);
    }

    #[test]
    fn resolve_paths_empty_db_returns_filter_as_fallback() {
        // Empty memories table: no stored rows can resolve. We still return
        // the filter value so the resulting query produces an empty result
        // set deterministically instead of erroring.
        let conn = make_memory_db();
        let paths = resolve_paths_for_memory_filter(&conn, "git:abc123").expect("resolve paths");
        assert_eq!(paths, vec!["git:abc123".to_string()]);
    }

    #[test]
    fn build_in_placeholders_renders_correct_indices() {
        // Sanity check the helper used to inject IN clauses into queries
        // that mix path params with status/category/limit/offset params.
        assert_eq!(build_in_placeholders(0, 1), "");
        assert_eq!(build_in_placeholders(1, 1), "?1");
        assert_eq!(build_in_placeholders(3, 1), "?1, ?2, ?3");
        assert_eq!(build_in_placeholders(2, 5), "?5, ?6");
    }

    #[test]
    fn get_memories_with_identity_filter_returns_matching_rows() {
        // End-to-end: send a `git:`/`dir:`-style identity to get_memories
        // and verify rows are returned. Pre-fix this returned zero.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/issue87-a", "ARCHITECTURE_DECISIONS", "active");
        insert_memory(&conn, "/tmp/issue87-a", "CONSTRAINTS", "active");
        insert_memory(&conn, "/tmp/issue87-b", "ARCHITECTURE_DECISIONS", "active");

        let identity = stable_dir_identity("/tmp/issue87-a");
        let rows = get_memories(&conn, Some(&identity), None, None, None, None, 100, 0)
            .expect("get_memories");

        assert_eq!(rows.len(), 2, "expected both memories under /tmp/issue87-a");
        for row in &rows {
            assert_eq!(row.project_path, "/tmp/issue87-a");
        }
    }

    #[test]
    fn get_memories_degrades_on_pre_v44_schema_without_classify_columns() {
        // make_memory_db() is a PRE-v44 schema (no importance/scope/shareable).
        // The dashboard never migrates, so get_memories must still work and
        // return literal defaults rather than erroring on the missing columns.
        let conn = make_memory_db();
        assert!(!memories_has_classify_columns(&conn));
        insert_memory(&conn, "/tmp/pre-v44", "CONSTRAINTS", "active");

        let rows = get_memories(&conn, None, None, None, None, None, 100, 0)
            .expect("get_memories must not error on a pre-v44 schema");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].importance, 50);
        assert_eq!(rows[0].scope, "project");
        assert!(!rows[0].shareable);
    }

    #[test]
    fn get_memories_degrades_without_memory_embeddings_table() {
        // A pre-vN / never-initialized DB may have `memories` but no
        // `memory_embeddings` table (the read-only dashboard never creates it).
        // get_memories and the stats path must report no embeddings rather than
        // erroring on the missing table.
        let conn = make_memory_db();
        conn.execute_batch("DROP TABLE memory_embeddings;")
            .expect("drop memory_embeddings");
        assert!(!table_exists(&conn, "memory_embeddings"));
        insert_memory(&conn, "/tmp/no-emb", "CONSTRAINTS", "active");

        let rows = get_memories(&conn, None, None, None, None, None, 100, 0)
            .expect("get_memories must not error when memory_embeddings is absent");
        assert_eq!(rows.len(), 1);
        assert!(
            !rows[0].has_embedding,
            "no embeddings table → has_embedding=false"
        );

        let stats = get_memory_stats(&conn, None, None).expect("stats must not error");
        assert_eq!(stats.with_embeddings, 0);
    }

    #[test]
    fn get_memories_reads_classify_columns_on_v44_schema() {
        let conn = make_memory_db();
        conn.execute_batch(
            "ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 50;
             ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'project';
             ALTER TABLE memories ADD COLUMN shareable INTEGER NOT NULL DEFAULT 0;",
        )
        .expect("add v44 columns");
        assert!(memories_has_classify_columns(&conn));
        let id = insert_memory(&conn, "/tmp/v44", "ARCHITECTURE", "active");
        conn.execute(
            "UPDATE memories SET importance = 88, scope = 'ecosystem', shareable = 1 WHERE id = ?1",
            [id],
        )
        .expect("set classify values");

        let rows = get_memories(&conn, None, None, None, None, None, 100, 0).expect("get_memories");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].importance, 88);
        assert_eq!(rows[0].scope, "ecosystem");
        assert!(rows[0].shareable);
    }

    #[test]
    fn get_memory_stats_with_identity_filter_returns_matching_counts() {
        // End-to-end: stats must also resolve identity → paths. Pre-fix the
        // total/active/permanent/archived/categories counts were all zero
        // whenever a project was selected from the frontend dropdown.
        let conn = make_memory_db();
        insert_memory(
            &conn,
            "/tmp/issue87-stats",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(&conn, "/tmp/issue87-stats", "CONSTRAINTS", "active");
        insert_memory(&conn, "/tmp/issue87-stats", "USER_DIRECTIVES", "archived");
        insert_memory(
            &conn,
            "/tmp/issue87-other",
            "ARCHITECTURE_DECISIONS",
            "active",
        );

        let identity = stable_dir_identity("/tmp/issue87-stats");
        let stats = get_memory_stats(&conn, Some(&identity), None).expect("get_memory_stats");

        assert_eq!(stats.total, 3);
        assert_eq!(stats.active, 2);
        assert_eq!(stats.archived, 1);
        assert_eq!(stats.permanent, 0);
        // Categories should list both active categories (archived excluded).
        let cat_names: Vec<&str> = stats
            .categories
            .iter()
            .map(|c| c.category.as_str())
            .collect();
        assert!(cat_names.contains(&"ARCHITECTURE_DECISIONS"));
        assert!(cat_names.contains(&"CONSTRAINTS"));
        assert!(!cat_names.contains(&"USER_DIRECTIVES")); // archived
    }

    #[test]
    fn get_memories_without_filter_returns_all() {
        // No regression for the unfiltered path.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/a", "X", "active");
        insert_memory(&conn, "/tmp/b", "Y", "active");

        let rows = get_memories(&conn, None, None, None, None, None, 100, 0).expect("get_memories");
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn get_memory_stats_without_filter_counts_everything() {
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/a", "X", "active");
        insert_memory(&conn, "/tmp/b", "Y", "permanent");
        insert_memory(&conn, "/tmp/c", "Z", "archived");

        let stats = get_memory_stats(&conn, None, None).expect("get_memory_stats");
        assert_eq!(stats.total, 3);
        assert_eq!(stats.active, 1);
        assert_eq!(stats.permanent, 1);
        assert_eq!(stats.archived, 1);
    }

    #[test]
    fn get_memory_stats_filter_resolving_to_zero_paths_does_not_crash() {
        // A requested filter that resolves to NO paths (e.g. an empty workspace,
        // or an identity with no memories) must report zero stats — not emit
        // `m.project_path IN ()` and crash the whole stats query. The
        // with_embeddings branch previously rebuilt the IN-list from an empty
        // resolved_paths instead of honoring the `0 = 1` empty-filter sentinel.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/has-mem", "X", "active");
        // An embedding row exists so the with_embeddings branch actually runs.
        conn.execute(
            "INSERT INTO memory_embeddings (memory_id, vector, model_id) VALUES (1, X'00', 'm')",
            [],
        )
        .expect("insert embedding");

        let stats = get_memory_stats(&conn, Some("git:does-not-exist"), None)
            .expect("stats must not crash on an empty-resolved filter");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.with_embeddings, 0);
    }

    #[test]
    fn get_projects_degrades_on_pre_dreamer_v2_schema() {
        // The dashboard opens DBs read-only and never migrates, so a DB older
        // than the Dreamer V2 schema has no task_schedule_state / dream_runs.
        // get_projects must still return memory-derived projects, not throw
        // "no such table".
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/proj-a", "X", "active");

        let projects = get_projects(&conn).expect("get_projects must degrade, not throw");
        assert!(
            projects
                .iter()
                .any(|p| p.identity == stable_dir_identity("/tmp/proj-a")),
            "memory-derived project must still appear"
        );
    }

    #[test]
    fn get_dream_state_degrades_on_pre_dreamer_v2_schema() {
        let conn = make_memory_db();
        let state = get_dream_state(&conn).expect("get_dream_state must degrade, not throw");
        assert!(state.is_empty());
    }

    /// Regression: `enumerate_memory_projects` returned rows whose
    /// `display_name` was the raw identity (for example `git:abc…`) because
    /// memory `project_path` values were passed into a function that expected
    /// filesystem paths. When no project matched that stored path, the row that
    /// `enumerate_memory_projects` fell back to used the raw identity string as
    /// both `primary_path` and `display_name`.
    ///
    /// Fix: filter the full enumerated project list by identity instead of by
    /// path string. Identity-shaped memory values map to themselves, and raw
    /// filesystem paths map to deterministic directory fallbacks.
    #[test]
    fn enumerate_memory_projects_with_identity_memories_does_not_leak_identity_as_name() {
        // Simulate memories whose stored project path is already the resolved
        // project identity.
        let conn = make_memory_db();
        insert_memory(&conn, "git:abc1234567890abcdef", "CONSTRAINTS", "active");
        insert_memory(
            &conn,
            "git:abc1234567890abcdef",
            "ARCHITECTURE_DECISIONS",
            "active",
        );
        insert_memory(
            &conn,
            "dir:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
            "USER_DIRECTIVES",
            "active",
        );

        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].identity,
            "dir:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
        );
        assert_eq!(rows[0].display_name, "dir:fedcba0987…");
        assert_eq!(rows[1].identity, "git:abc1234567890abcdef");
        assert_eq!(rows[1].display_name, "git:abc1234567…");
    }

    #[test]
    fn enumerate_memory_projects_with_only_archived_memories_returns_empty() {
        // `enumerate_memory_projects` filters memories by `status = 'active'`.
        // A project whose only memories are archived should not appear in the
        // picker at all. (This was already the behavior before the fix; we
        // pin it so the new identity-filtering path doesn't accidentally
        // surface archived-only projects.)
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/archived-only", "X", "archived");
        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        assert!(rows.is_empty(), "archived-only project leaked: {rows:?}");
    }

    #[test]
    fn enumerate_memory_projects_empty_db_returns_empty() {
        let conn = make_memory_db();
        let rows = enumerate_memory_projects(&conn).expect("enumerate");
        assert!(
            rows.is_empty(),
            "empty db should produce empty picker, got {rows:?}"
        );
    }
}

#[cfg(test)]
mod pre_vn_degrade_tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn missing_task_schedule_state_returns_empty() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(get_task_schedule_state(&conn).unwrap().is_empty());
        assert!(get_dreamer_projects(&conn).unwrap().is_empty());
    }

    #[test]
    fn dream_runs_without_parent_session_id_still_load() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE dream_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER NOT NULL,
                holder_id TEXT,
                tasks_json TEXT,
                tasks_succeeded INTEGER,
                tasks_failed INTEGER,
                smart_notes_surfaced INTEGER,
                smart_notes_pending INTEGER,
                memory_changes_json TEXT
            );
            INSERT INTO dream_runs
                (project_path, started_at, finished_at, holder_id, tasks_json,
                 tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending,
                 memory_changes_json)
            VALUES ('dir:proj', 10, 20, 'holder', '[]', 1, 0, 0, 0, NULL);",
        )
        .unwrap();

        let runs = get_dream_runs(&conn, None, 10).expect("pre-parent dream runs should load");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].project_path, "dir:proj");
        assert_eq!(runs[0].parent_session_id, None);
    }

    #[test]
    fn old_notes_without_late_columns_return_default_nulls() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL DEFAULT 'session',
                status TEXT NOT NULL DEFAULT 'active',
                content TEXT NOT NULL,
                session_id TEXT,
                project_path TEXT,
                surface_condition TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at)
            VALUES ('session', 'active', 'session note', 'ses_1', NULL, NULL, 10, 11);
            INSERT INTO notes (type, status, content, session_id, project_path, surface_condition, created_at, updated_at)
            VALUES ('smart', 'ready', 'smart note', NULL, 'dir:proj', 'always', 12, 13);",
        )
        .unwrap();

        let session_notes = get_session_notes(&conn, "ses_1").expect("session notes");
        assert_eq!(session_notes.len(), 1);
        assert_eq!(session_notes[0].content, "session note");
        assert_eq!(session_notes[0].last_checked_at, None);
        assert_eq!(session_notes[0].ready_at, None);
        assert_eq!(session_notes[0].ready_reason, None);

        let smart_notes = get_smart_notes(&conn, "dir:proj").expect("smart notes");
        assert_eq!(smart_notes.len(), 1);
        assert_eq!(smart_notes[0].content, "smart note");
        assert_eq!(smart_notes[0].last_checked_at, None);
        assert_eq!(smart_notes[0].ready_at, None);
        assert_eq!(smart_notes[0].ready_reason, None);
    }

    #[test]
    fn missing_notes_table_returns_empty() {
        let conn = Connection::open_in_memory().unwrap();
        assert!(get_session_notes(&conn, "ses_1").unwrap().is_empty());
        assert!(get_smart_notes(&conn, "dir:proj").unwrap().is_empty());
    }
}

#[cfg(test)]
mod dream_run_memory_changes_tests {
    //! #221: Dreamer v2 persists the exact changed ids in
    //! `memory_changes_json` ({writtenIds, archivedIds, mergedIds}). The
    //! drill-down should read those directly (exact) and fall back to the
    //! time-window reconstruction only for older counts-only rows.
    use super::*;
    use rusqlite::Connection;

    fn make_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER,
                updated_at INTEGER,
                superseded_by_memory_id INTEGER
            );
            CREATE TABLE dream_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_path TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                finished_at INTEGER NOT NULL,
                holder_id TEXT,
                tasks_json TEXT,
                tasks_succeeded INTEGER,
                tasks_failed INTEGER,
                smart_notes_surfaced INTEGER,
                smart_notes_pending INTEGER,
                memory_changes_json TEXT,
                parent_session_id TEXT
            );",
        )
        .expect("schema");
        conn
    }

    fn insert_memory(conn: &Connection, id: i64, status: &str, created: i64, updated: i64) {
        conn.execute(
            "INSERT INTO memories (id, project_path, category, content, status, created_at, updated_at)
             VALUES (?1, 'dir:proj', 'PROJECT_RULES', ?2, ?3, ?4, ?5)",
            (id, format!("memory {id}"), status, created, updated),
        )
        .expect("insert memory");
    }

    fn insert_run(conn: &Connection, changes_json: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO dream_runs (project_path, started_at, finished_at, holder_id, tasks_json, tasks_succeeded, tasks_failed, smart_notes_surfaced, smart_notes_pending, memory_changes_json)
             VALUES ('dir:proj', 1000, 2000, 'h', '[]', 1, 0, 0, 0, ?1)",
            [changes_json],
        )
        .expect("insert run");
        conn.last_insert_rowid()
    }

    #[test]
    fn uses_exact_ids_when_present() {
        let conn = make_db();
        // A memory created LONG before the run window — the time-window path
        // would MISS it, so finding it proves the exact-id path was taken.
        insert_memory(&conn, 10, "active", 1, 1);
        insert_memory(&conn, 11, "archived", 1, 1);
        let run = insert_run(
            &conn,
            Some(
                r#"{"written":1,"archived":1,"merged":0,"writtenIds":[10],"archivedIds":[11],"mergedIds":[]}"#,
            ),
        );

        let detail = get_dream_run_memory_changes(&conn, run).expect("detail");
        assert_eq!(detail.written.len(), 1);
        assert_eq!(detail.written[0].id, 10);
        assert_eq!(detail.archived.len(), 1);
        assert_eq!(detail.archived[0].id, 11);
        assert!(detail.merged.is_empty());
    }

    #[test]
    fn skips_ids_no_longer_present() {
        let conn = make_db();
        insert_memory(&conn, 10, "active", 1, 1);
        // id 99 referenced by the run but since deleted → silently dropped.
        let run = insert_run(
            &conn,
            Some(
                r#"{"written":2,"archived":0,"merged":0,"writtenIds":[10,99],"archivedIds":[],"mergedIds":[]}"#,
            ),
        );
        let detail = get_dream_run_memory_changes(&conn, run).expect("detail");
        assert_eq!(detail.written.len(), 1);
        assert_eq!(detail.written[0].id, 10);
    }

    #[test]
    fn falls_back_to_time_window_for_counts_only_rows() {
        let conn = make_db();
        // Created INSIDE the window → time-window path classifies it as written.
        insert_memory(&conn, 20, "active", 1500, 1500);
        // counts-only blob (legacy run): no *Ids arrays.
        let run = insert_run(&conn, Some(r#"{"written":1,"archived":0,"merged":0}"#));
        let detail = get_dream_run_memory_changes(&conn, run).expect("detail");
        assert_eq!(detail.written.len(), 1);
        assert_eq!(detail.written[0].id, 20);
    }

    #[test]
    fn empty_id_arrays_short_circuit_to_empty() {
        let conn = make_db();
        // A memory created in-window that the time-window path WOULD pick up —
        // but the run explicitly recorded empty id arrays, so the exact path
        // must win and return nothing.
        insert_memory(&conn, 30, "active", 1500, 1500);
        let run = insert_run(
            &conn,
            Some(
                r#"{"written":0,"archived":0,"merged":0,"writtenIds":[],"archivedIds":[],"mergedIds":[]}"#,
            ),
        );
        let detail = get_dream_run_memory_changes(&conn, run).expect("detail");
        assert!(detail.written.is_empty());
        assert!(detail.archived.is_empty());
        assert!(detail.merged.is_empty());
    }
}

#[cfg(test)]
mod external_cache_incremental_tests {
    use super::*;
    use crate::external_cache_sessions;
    use std::fs::{self, File};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn set_modified_time(path: &Path, modified: SystemTime) {
        File::open(path)
            .expect("open fixture")
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .expect("set fixture mtime");
    }

    #[test]
    fn incremental_external_load_skips_unchanged_files_and_reads_touched_files() {
        external_cache_sessions::clear_caches_for_tests();
        let dir = tempfile::tempdir().expect("fixture directory");
        let path = dir.path().join("project/session.jsonl");
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
        fs::write(
            &path,
            r#"{"type":"assistant","uuid":"cc-main-1","sessionId":"cc-session","timestamp":"2030-01-01T00:00:05.000Z","cwd":"/tmp/proj","isSidechain":false,"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":25,"output_tokens":5}}}
"#,
        )
        .expect("write fixture");

        let since_timestamp = 1_893_456_000_000;
        set_modified_time(&path, UNIX_EPOCH + Duration::from_secs(1));
        external_cache_sessions::set_claude_code_test_root_for_tests(dir.path().to_path_buf());
        assert!(load_raw_claude_code_cache_events(200, Some(since_timestamp)).is_empty());

        set_modified_time(
            &path,
            UNIX_EPOCH + Duration::from_millis((since_timestamp + 10_000) as u64),
        );
        external_cache_sessions::clear_caches_for_tests();
        external_cache_sessions::set_claude_code_test_root_for_tests(dir.path().to_path_buf());
        let rows = load_raw_claude_code_cache_events(200, Some(since_timestamp));

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_id, "cc-main-1");
        external_cache_sessions::clear_caches_for_tests();
    }
}
