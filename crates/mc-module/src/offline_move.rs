//! Offline move of one standalone OpenCode 1 session to mode 3 (a session runner
//! plus ck-mc's async compaction lane).
//!
//! It runs only in a restart window, with OpenCode and ck-mc stopped. The window
//! job takes clone backups of all three stores first, so recovery is "restore the
//! backups". This command keeps no journal of its own. Its two writes are ordered so
//! that running it again after a crash at any point ends in the same state:
//!
//! 1. the three marker rows are relocated onto the cut `U` in one host
//!    transaction on `opencode.db`: the old triple is deleted and the new triple
//!    (compaction part, summary message, summary text part) is inserted with the
//!    plugin writer's bytes for `resolvedBoundary = U` and `endMessageId = P`,
//!    plus exactly the `cortexkit` key
//!    `{"tag_checkpoint": N, "session": S, "message_count": M}` on the
//!    compaction part (the key gains `head_cut` once the runner's export
//!    certifies it);
//! 2. the moved record goes into `context.db`, last. It is the commit point: before
//!    it exists the session still belongs to the standalone plugin; once it exists,
//!    the plugin refuses the session and ck-mc's setup imports it.
//!
//! The moved record carries everything ck-mc's setup needs: the session's
//! compartments, the cut (the boundary user message that holds the standalone
//! marker; standalone markers have no `tail_start_id`), the checkpoint `N`, and the
//! applied and queued drops after the cut, keyed by OpenCode `(message id, part id)`.
//! ck-mc binds each drop's content digest from the runner's own served part on its
//! first read after setup, so this command never computes a digest.
//!
//! The record lives in `context.db`'s `schema_migrations_meta` key/value table under
//! the key `mode3_move:opencode:<session id>`. That table already holds other
//! per-session keys, so the move needs no schema migration.
//!
//! Stable refusal code table for admission and the move lifecycle. Planning is
//! read-only; certificate, persisted-image, record-state and codec checks belong
//! to the corresponding apply/resume/Setup stages, not admission.
//!
//! | Refusal condition | Code |
//! | --- | --- |
//! | Summary has a block index | `block_index` |
//! | Summary has no endpoint id | `summary_id_missing` |
//! | Summary endpoint is not counted | `summary_endpoint_missing` |
//! | Summary starts after its end | `summary_inverted` |
//! | First summary does not start at 1 | `prefix_gap` |
//! | Summaries overlap or leave a gap | `prefix_not_tiled` |
//! | Fold end T is absent | `fold_end_missing` |
//! | Fold end T is not summarized | `fold_end_uncovered` |
//! | No cut can carry a marker | `no_eligible_cut` |
//! | Cut U is 1 | `empty_prefix` |
//! | Summary crosses U | `cut_straddled` |
//! | Imported prefix does not end at U - 1 | `prefix_end_mismatch` |
//! | Every eligible carrier has a neighbour at its time or time + 1 | `adjacency_conflict` |
//! | Projected marker would not be in effect | `marker_shadowed` |
//! | Old marker carrier is P, the certified head-cut message | `marker_on_head_cut` |
//! | Present retained message has an unresolvable target part | `drop_target_missing` |
//! | Drop target is not unique (formerly `target_ambiguous`) | `drop_target_ambiguous` |
//! | Model-visible drop target cannot carry a runner tag | `drop_target_untagged` |
//! | Export certificate disagrees with the plan | `certificate_mismatch` |
//! | Host matches neither persisted image | `move_host_state_unknown` |
//! | Move record cannot be decoded | `move_record_unreadable` |
//! | Move record has an unknown state | `move_record_state_unknown` |
//! | Setup codec differs from the move codec | `moved_session_codec_mismatch` |
//!
//! Kept verbatim: `marker_state_mismatch`, `marker_not_standalone`,
//! `address_malformed`, `marker_pending_not_in_effect`, `destination_not_empty`,
//! `marker_missing`, `summaries_missing`. All other existing codes stay unchanged:
//! `session_not_found`, `already_moved`, `queue_invalid`, `marker_ambiguous`,
//! `fork_unsupported`, `checkpoint_conflict`, `summary_boundary_unrepresentable`,
//! `source_changed`, and the store-level refusal codes.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Key prefix of a moved record in `context.db`'s `schema_migrations_meta`.
pub const MOVE_RECORD_PREFIX: &str = "mode3_move:opencode:";
/// The setup refusal for a session that still has standalone state and was never
/// moved, as compaction-provider 0.4.0 publishes it.
pub use cortexkit_role_compaction_provider::errors::refuse_codes::STANDALONE_SESSION_NOT_MIGRATED;
/// Version of the moved record's JSON shape. The per-endpoint CK block ids
/// and the codec profile do not bump it; bump the version when adding the
/// intent, the states and `head_cut`. No moved record exists anywhere yet.
pub const RECORD_VERSION: u32 = 1;
const HARNESS: &str = "opencode";
/// The `providerID`/`modelID` standalone writes on its compaction summary message.
const STANDALONE_MARKER_PROVIDER: &str = "magic-context";

/// The `schema_migrations_meta` key of `session`'s moved record.
pub fn move_record_key(session: &str) -> String {
    format!("{MOVE_RECORD_PREFIX}{session}")
}

// ── Marker id generator (ported whole from the plugin) ────────────────────
//
// The plugin's `compaction-marker.ts` generator, `deterministicBase62`
// included: `prefix_[12-hex-chars][14-deterministic-base62]`. The time prefix
// keeps OpenCode's lexicographic ordering; the hash suffix makes retries for
// the same marker identity converge on the same rows.

const BASE62_CHARS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PREFIX_HEX_LENGTH: usize = 12;
const ID_SUFFIX_LENGTH: usize = 14;
const ID_PREFIX_MASK: u128 = (1 << (ID_PREFIX_HEX_LENGTH * 4)) - 1;

/// The plugin's `deterministicBase62`: the low `length` base-62 digits of the
/// SHA-256 of `seed`, most significant digit first, with leading zeros.
fn deterministic_base62(seed: &str, length: usize) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hash = hasher.finalize();
    let mut num = hash.to_vec();
    let mut chars = vec![b'0'; length];
    for index in (0..length).rev() {
        let mut remainder: u32 = 0;
        for byte in num.iter_mut() {
            let current = remainder * 256 + u32::from(*byte);
            *byte = (current / 62) as u8;
            remainder = current % 62;
        }
        chars[index] = BASE62_CHARS[remainder as usize];
    }
    String::from_utf8(chars).expect("base62 is ASCII")
}

/// The plugin's `generateId`: `(timestampMs * 0x1000 + counter)` masked to 48
/// bits as 12 hex chars, then the hash suffix. `timestampMs` is clamped at zero
/// exactly as the plugin clamps it.
fn generate_id(prefix: &str, timestamp_ms: i64, counter: u64, identity: &str) -> String {
    let clamped = timestamp_ms.max(0) as u64 as u128;
    let encoded = (clamped * 0x1000 + u128::from(counter)) & ID_PREFIX_MASK;
    let hex = format!("{encoded:012x}");
    let seed = format!("{prefix}\0{identity}");
    format!(
        "{prefix}_{hex}{}",
        deterministic_base62(&seed, ID_SUFFIX_LENGTH)
    )
}

/// The plugin's `generateMessageId`.
fn generate_message_id(timestamp_ms: i64, counter: u64, identity: &str) -> String {
    generate_id("msg", timestamp_ms, counter, identity)
}

/// The plugin's `generatePartId`.
fn generate_part_id(timestamp_ms: i64, counter: u64, identity: &str) -> String {
    generate_id("prt", timestamp_ms, counter, identity)
}

/// What the offline move hands to ck-mc's setup for one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveRecord {
    pub version: u32,
    pub session: String,
    pub harness: String,
    /// The highest tag number standalone ever allocated for the session. New
    /// runner numbers start above it.
    pub tag_checkpoint: u64,
    /// The OpenCode message id of the boundary user message (the cut).
    pub cut: String,
    /// The compaction part that carries the checkpoint key.
    pub marker_part: String,
    /// The codec the offline block ids were computed with: the serializer
    /// profile and how `nativeIndex` maps to the host part order.
    #[serde(default)]
    pub codec_profile: CodecProfile,
    /// The session's compartments in sequence order, bound to ck-mc ordinals by
    /// message id on the first read.
    pub compartments: Vec<ImportedCompartment>,
    /// Applied and queued drops on parts after the cut.
    pub drops: Vec<CarriedDrop>,
}

/// The offline codec profile for CK block ids: the `edge_block` serializer and
/// the `nativeIndex` mapping it uses over the host message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CodecProfile {
    /// The provider codec's `serializer_profile` wire id (OpenCode 1 moves
    /// always use `"opencode-aisdk"`).
    #[serde(default)]
    pub serializer: String,
    /// How `nativeIndex` maps to the host part order (`"part_index"`: the
    /// codec stamps each CK block with its OpenCode part index).
    #[serde(default)]
    pub native_index: String,
}

/// One standalone compartment. Endpoints are OpenCode message ids; a partial
/// endpoint also names the OpenCode part id where the compartment starts or ends
/// inside that message. `start_block`/`end_block` are the CK block indexes of the
/// endpoint inside its host message, computed offline with the `edge_block`
/// codec over that message (whole-message endpoints cover the first through the
/// last CK block); the import step builds the exact `StoredCompartment` rows from them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportedCompartment {
    pub sequence: i64,
    pub start_message_id: String,
    #[serde(default)]
    pub start_part: Option<String>,
    #[serde(default)]
    pub start_block: Option<usize>,
    pub end_message_id: String,
    #[serde(default)]
    pub end_part: Option<String>,
    #[serde(default)]
    pub end_block: Option<usize>,
    pub title: String,
    pub content: String,
    pub p1: Option<String>,
    pub p2: Option<String>,
    pub p3: Option<String>,
    pub p4: Option<String>,
    pub importance: i32,
    pub episode_type: Option<String>,
    pub legacy: i32,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DropKind {
    /// Standalone already serves the part dropped.
    Applied,
    /// A `ctx_reduce` stamp standalone has queued but not applied yet.
    Queued,
}

/// A drop carried to ck-mc, keyed by the OpenCode identity of its part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CarriedDrop {
    pub mid: String,
    pub part: String,
    pub kind: DropKind,
    /// The standalone tag number the drop was recorded under, for the plan only.
    pub source_tag: u64,
    /// Standalone's drop rendering (`full`, `truncated`, `skeleton_*`, ...). ck-mc
    /// renders every carried drop its own way; this is kept for the plan.
    #[serde(default)]
    pub drop_mode: Option<String>,
    #[serde(default)]
    pub queued_at_ms: Option<i64>,
}

/// A named reason the session stays on standalone. No store was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
}

impl Refusal {
    pub(crate) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.detail)
    }
}

fn sql(error: rusqlite::Error) -> Refusal {
    Refusal::new("store_unreadable", error.to_string())
}

/// The three stores, named explicitly; nothing is discovered from the environment.
#[derive(Debug, Clone)]
pub struct StorePaths {
    pub opencode_db: PathBuf,
    pub context_db: PathBuf,
    pub store_db: PathBuf,
}

impl StorePaths {
    fn all(&self) -> [&Path; 3] {
        [&self.opencode_db, &self.context_db, &self.store_db]
    }
}

/// Lists the processes, other than this one, that hold any of the given files open.
pub trait HolderCheck {
    fn holders(&self, files: &[PathBuf]) -> Result<Vec<String>, String>;
}

/// The holder check the command uses: `lsof` over each database and its
/// `-wal`/`-shm` files, as the restart window job does.
pub struct Lsof;

impl HolderCheck for Lsof {
    fn holders(&self, files: &[PathBuf]) -> Result<Vec<String>, String> {
        let present: Vec<&PathBuf> = files.iter().filter(|path| path.exists()).collect();
        if present.is_empty() {
            return Ok(Vec::new());
        }
        let output = std::process::Command::new("lsof")
            .arg("-F")
            .arg("pc")
            .arg("--")
            .args(&present)
            .output()
            .map_err(|error| format!("lsof could not run: {error}"))?;
        // lsof exits 1 when no file is open; any listed process is a holder.
        let own = std::process::id().to_string();
        let mut holders = Vec::new();
        let mut pid = None;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(value) = line.strip_prefix('p') {
                pid = Some(value.to_owned());
            } else if let Some(command) = line.strip_prefix('c') {
                if let Some(pid) = pid.as_ref().filter(|pid| **pid != own) {
                    holders.push(format!("{command}/{pid}"));
                }
            }
        }
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(format!(
                "lsof failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        holders.sort();
        holders.dedup();
        Ok(holders)
    }
}

fn database_files(paths: &StorePaths) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths.all() {
        files.push(path.to_path_buf());
        for suffix in ["-wal", "-shm"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            files.push(PathBuf::from(name));
        }
    }
    files
}

/// Refuse while any other process holds a target database. The window job checks
/// this too; the move checks again because it is the one about to write.
pub fn check_holders(paths: &StorePaths, check: &dyn HolderCheck) -> Result<(), Refusal> {
    match check.holders(&database_files(paths)) {
        Ok(holders) if holders.is_empty() => Ok(()),
        Ok(holders) => Err(Refusal::new(
            "stores_in_use",
            format!(
                "stop these processes and rerun in the restart window: {}",
                holders.join(", ")
            ),
        )),
        Err(reason) => Err(Refusal::new("offline_exclusivity_unproven", reason)),
    }
}

/// Open a database for reading without creating or changing anything. A WAL
/// database that has a `-wal` file is opened read-only, so its committed WAL
/// content is read. One without a `-wal` file has nothing outside the main file,
/// and is opened immutable: a plain read-only open would create empty `-wal` and
/// `-shm` files. Nothing else holds it open (the holder check ran first), as
/// immutable requires; the restart window job reads its stores the same way.
pub(crate) fn open_read_only(path: &Path) -> Result<Connection, Refusal> {
    if !path.exists() {
        return Err(Refusal::new(
            "store_missing",
            format!("{} does not exist", path.display()),
        ));
    }
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    let mode = if Path::new(&wal).exists() {
        "mode=ro"
    } else {
        "immutable=1"
    };
    let mut encoded = String::new();
    for ch in path.to_string_lossy().chars() {
        match ch {
            '%' => encoded.push_str("%25"),
            '?' => encoded.push_str("%3f"),
            '#' => encoded.push_str("%23"),
            other => encoded.push(other),
        }
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    Connection::open_with_flags(format!("file:{encoded}?{mode}"), flags).map_err(sql)
}

fn table_exists(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |row| row.get(0),
    )
}

/// The raw moved record of `session`, if one was written.
pub fn read_move_record_raw(conn: &Connection, session: &str) -> rusqlite::Result<Option<String>> {
    if !table_exists(conn, "schema_migrations_meta")? {
        return Ok(None);
    }
    conn.query_row(
        "SELECT value FROM schema_migrations_meta WHERE key=?1",
        [move_record_key(session)],
        |row| row.get(0),
    )
    .optional()
}

/// The moved record of `session`. `Some(Err(_))` is a record that exists but does
/// not parse: callers must treat the session as moved and refuse to use it.
pub fn read_move_record(
    conn: &Connection,
    session: &str,
) -> rusqlite::Result<Option<Result<MoveRecord, String>>> {
    Ok(read_move_record_raw(conn, session)?.map(|raw| {
        serde_json::from_str::<MoveRecord>(&raw)
            .map_err(|error| error.to_string())
            .and_then(|record| {
                if record.version == RECORD_VERSION && record.session == session {
                    Ok(record)
                } else {
                    Err(format!(
                        "moved record version {} for session {:?}",
                        record.version, record.session
                    ))
                }
            })
    }))
}

/// Whether `context.db` holds standalone OpenCode 1 state for `session`: rows the
/// standalone plugin keys by the raw OpenCode session id. ck-mc's async lane keys
/// its own rows by its namespace, never by the raw id.
pub fn has_standalone_state(conn: &Connection, session: &str) -> rusqlite::Result<bool> {
    for table in ["session_meta", "tags", "compartments", "pending_ops"] {
        if !table_exists(conn, table)? {
            continue;
        }
        let found: bool = conn.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE session_id=?1 AND harness=?2)"),
            params![session, HARNESS],
            |row| row.get(0),
        )?;
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

// ── Reading the source ───────────────────────────────────────────────────

#[derive(Clone)]
struct MessageRow {
    id: String,
    time: i64,
    role: String,
    summary: bool,
    finished: bool,
    errored: bool,
    parent: Option<String>,
    provider: Option<String>,
    counted: bool,
}

#[derive(Clone)]
struct PartRow {
    id: String,
    kind: String,
    call_id: Option<String>,
    /// A whitespace-only text part on an assistant message: standalone treats it
    /// as provider framing and replays only an exact tag for it.
    blank_text: bool,
    synthetic: bool,
    taggable: bool,
    not_served: bool,
}

/// The session as OpenCode 1 stores it: messages in canonical `(time_created,
/// id)` order and each message's parts in the order OpenCode loads them (by id).
#[derive(Clone)]
struct HostSession {
    messages: Vec<MessageRow>,
    /// Plugin-counted, 1-based positions, not raw host row indexes.
    position: HashMap<String, usize>,
    parts: HashMap<String, Vec<PartRow>>,
}

/// The plugin skips only summary=true/1 with finish="stop", regardless of role.
fn plugin_finished_summary(data: &Value) -> bool {
    (data["summary"] == true || data["summary"].as_f64() == Some(1.0)) && data["finish"] == "stop"
}

/// Use the OpenCode decoder that exposes message content so this check handles
/// error results and media attachments the same way. Empty text and opaque
/// structured results cannot carry a visible tag number.
fn runner_taggable_part(part: &Value) -> bool {
    use crate::ck_wire::{CkKind, CkOutputKind, ResultBlockKind};
    let decoded = crate::codec::opencode::decode_opencode(&[json!({
        "info": {"id":"move-admission", "role":"assistant"},
        "parts": [part],
    })]);
    decoded.messages.iter().any(|message| {
        message.ck.content.iter().any(|block| match &block.kind {
            CkKind::Text { text } => !text.is_empty(),
            CkKind::ToolResult { output, .. } => match &output.kind {
                CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => !text.is_empty(),
                CkOutputKind::Content { blocks } | CkOutputKind::ErrorContent { blocks } => {
                    blocks.iter().any(|block| match &block.kind {
                        ResultBlockKind::Text { text } => !text.is_empty(),
                        ResultBlockKind::Media { .. } => true,
                        _ => false,
                    })
                }
                _ => false,
            },
            _ => false,
        })
    })
}

/// The offline `edge_block` codec profile for CK block ids: the serializer the
/// live binder uses, and how `nativeIndex` maps to the host part order.
fn offline_codec_profile() -> CodecProfile {
    CodecProfile {
        serializer: "opencode-aisdk".to_owned(),
        native_index: "part_index".to_owned(),
    }
}

/// The CK block range of one host message, computed offline with the same codec
/// `edge_block` uses: decode the message's parts in OpenCode part order and
/// take the first through the last CK block. Parts the runner never serves
/// (the compaction part, ignored or empty text) decode to no block, exactly as
/// they do live, so a whole-message endpoint covers the decoded range. `None`
/// when the message decodes to no CK block.
fn offline_ck_block_range(role: &str, part_datas: &[Value]) -> Option<(usize, usize)> {
    let decoded = crate::codec::opencode::decode_opencode(&[json!({
        "info": {"id": "move-block-id", "role": role},
        "parts": part_datas,
    })]);
    let len = decoded
        .messages
        .first()
        .map(|message| message.ck.content.len())
        .unwrap_or(0);
    if len == 0 {
        None
    } else {
        Some((0, len - 1))
    }
}

/// A host message's parts as stored, in the order OpenCode loads them (by id),
/// for the offline block-id computation.
fn host_part_datas(conn: &Connection, session: &str, mid: &str) -> Result<Vec<Value>, Refusal> {
    let mut statement = conn
        .prepare("SELECT data FROM part WHERE session_id=?1 AND message_id=?2 ORDER BY id")
        .map_err(sql)?;
    let rows = statement
        .query_map(params![session, mid], |row| row.get::<_, String>(0))
        .map_err(sql)?;
    let mut datas = Vec::new();
    for row in rows {
        let data = row.map_err(sql)?;
        datas.push(serde_json::from_str::<Value>(&data).unwrap_or(Value::Null));
    }
    Ok(datas)
}

fn load_host_session(conn: &Connection, session: &str) -> Result<HostSession, Refusal> {
    for table in ["message", "part"] {
        if !table_exists(conn, table).map_err(sql)? {
            return Err(Refusal::new(
                "not_standalone_opencode1",
                format!("opencode.db has no `{table}` table; it is not an OpenCode 1 store"),
            ));
        }
    }
    let mut messages = Vec::new();
    let mut statement = conn
        .prepare(
            "SELECT id, time_created, data
                FROM message WHERE session_id=?1 ORDER BY time_created, id",
        )
        .map_err(sql)?;
    let rows = statement
        .query_map([session], |row| {
            // The plugin counts malformed JSON as an ordinary row.
            let data: String = row.get(2)?;
            let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
            let summary = data["summary"] == true || data["summary"] == 1;
            Ok(MessageRow {
                id: row.get(0)?,
                time: row.get(1)?,
                role: data["role"].as_str().unwrap_or_default().into(),
                summary,
                finished: data["finish"]
                    .as_str()
                    .is_some_and(|finish| !finish.is_empty()),
                errored: data.get("error").is_some(),
                parent: data["parentID"].as_str().map(str::to_owned),
                provider: data["providerID"].as_str().map(str::to_owned),
                counted: !plugin_finished_summary(&data),
            })
        })
        .map_err(sql)?;
    for row in rows {
        messages.push(row.map_err(sql)?);
    }
    if messages.is_empty() {
        return Err(Refusal::new(
            "session_not_found",
            format!("opencode.db has no messages for session {session}"),
        ));
    }
    let roles = messages
        .iter()
        .map(|message| (message.id.as_str(), message.role.as_str()))
        .collect::<HashMap<_, _>>();
    let mut parts: HashMap<String, Vec<PartRow>> = HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT id, message_id, COALESCE(json_extract(data,'$.type'),''),
                    json_extract(data,'$.callID'),
                    length(trim(COALESCE(json_extract(data,'$.text'),''))) = 0,
                    COALESCE(json_extract(data,'$.synthetic'),0)=1 OR
                    COALESCE(json_extract(data,'$.syntheticTodoMarker'),0)=1,
                    data
               FROM part WHERE session_id=?1 ORDER BY message_id, id",
        )
        .map_err(sql)?;
    let rows = statement
        .query_map([session], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(0)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, bool>(4)?,
                row.get::<_, bool>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(sql)?;
    for row in rows {
        let (message, id, kind, call_id, empty_text, synthetic, data) = row.map_err(sql)?;
        let blank_text =
            kind == "text" && empty_text && roles.get(message.as_str()) == Some(&"assistant");
        let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let taggable = runner_taggable_part(&data);
        let not_served = data["ignored"] == true
            || (matches!(kind.as_str(), "text" | "reasoning") && data["text"] == "")
            || (kind == "tool"
                && matches!(
                    data["state"]["status"].as_str(),
                    Some("completed" | "error")
                )
                && !taggable);
        parts.entry(message).or_default().push(PartRow {
            id,
            kind,
            call_id,
            blank_text,
            synthetic,
            taggable,
            not_served,
        });
    }
    for message in &mut messages {
        if parts.get(&message.id).is_some_and(|parts| {
            !parts.is_empty() && parts.iter().all(|part| part.kind == "compaction")
        }) {
            message.counted = false;
        }
    }
    let position = messages
        .iter()
        .filter(|message| message.counted)
        .enumerate()
        .map(|(index, message)| (message.id.clone(), index + 1))
        .collect();
    Ok(HostSession {
        messages,
        position,
        parts,
    })
}

/// The marker OpenCode 1 would apply next: walking newest to oldest, the first user
/// message carrying a compaction part whose completed, error-free summary message
/// names it as parent. This is OpenCode's `filterCompacted` rule.
fn in_effect_marker(host: &HostSession) -> Option<(usize, &MessageRow)> {
    let mut completed: HashMap<&str, &MessageRow> = HashMap::new();
    for (index, message) in host.messages.iter().enumerate().rev() {
        if message.role == "user" {
            if let Some(summary) = completed.get(message.id.as_str()) {
                let has_compaction = host
                    .parts
                    .get(&message.id)
                    .is_some_and(|parts| parts.iter().any(|part| part.kind == "compaction"));
                if has_compaction {
                    return Some((index, summary));
                }
            }
        }
        if message.role == "assistant" && message.summary && message.finished && !message.errored {
            if let Some(parent) = &message.parent {
                completed.entry(parent.as_str()).or_insert(message);
            }
        }
    }
    None
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum PositionalKind {
    Text,
    File,
}

/// Parse standalone's positional address `<message id>:p<index>` (text) or
/// `<message id>:file<index>` (file); the index counts every part of the message.
fn parse_positional(address: &str) -> Option<(&str, PositionalKind, usize)> {
    let (head, digits) =
        address.split_at(address.trim_end_matches(|c: char| c.is_ascii_digit()).len());
    if digits.is_empty() {
        return None;
    }
    let index = digits.parse().ok()?;
    if let Some(mid) = head.strip_suffix(":file") {
        Some((mid, PositionalKind::File, index))
    } else {
        head.strip_suffix(":p")
            .map(|mid| (mid, PositionalKind::Text, index))
    }
    .filter(|(mid, _, _)| !mid.is_empty())
}

/// Standalone's rule for which tag a message's text and file parts carry on its
/// next pass (`tag-messages.ts` with `tag-id-fallback.ts`). Each text part at part
/// index `i` takes the tag recorded at `<mid>:p<i>`. Failing that, it takes the tag
/// at the same per-type ordinal among the message's recorded addresses, provided
/// that tag is not used yet this pass and its address is not one an earlier part
/// already claimed. File parts follow the same rule with `:file<i>`. A
/// whitespace-only assistant text part takes only its exact tag, and still
/// advances the text ordinal. Returns tag number → OpenCode part id.
fn resolve_positional_tags(
    parts: &[PartRow],
    assigned: &[(PositionalKind, usize, u64)],
) -> HashMap<u64, String> {
    let exact: HashMap<(PositionalKind, usize), u64> = assigned
        .iter()
        .map(|(kind, index, tag)| ((*kind, *index), *tag))
        .collect();
    let mut scoped: HashMap<PositionalKind, Vec<(usize, u64)>> = HashMap::new();
    for (kind, index, tag) in assigned {
        scoped.entry(*kind).or_default().push((*index, *tag));
    }
    for list in scoped.values_mut() {
        list.sort_unstable();
    }
    let mut used = HashSet::new();
    let mut claimed = HashSet::new();
    let mut ordinals: HashMap<PositionalKind, usize> = HashMap::new();
    let mut bound = HashMap::new();
    for (index, part) in parts.iter().enumerate() {
        let kind = match part.kind.as_str() {
            "text" => PositionalKind::Text,
            "file" => PositionalKind::File,
            _ => continue,
        };
        let ordinal = ordinals.entry(kind).or_default();
        let current = *ordinal;
        *ordinal += 1;
        claimed.insert((kind, index));
        if let Some(tag) = exact.get(&(kind, index)) {
            used.insert(*tag);
            bound.insert(*tag, part.id.clone());
            continue;
        }
        if part.blank_text {
            continue;
        }
        let Some((fallback_index, tag)) = scoped.get(&kind).and_then(|list| list.get(current))
        else {
            continue;
        };
        if used.contains(tag) || claimed.contains(&(kind, *fallback_index)) {
            continue;
        }
        used.insert(*tag);
        bound.insert(*tag, part.id.clone());
    }
    bound
}

// ── Planning ─────────────────────────────────────────────────────────────

/// Everything the move would write, computed without writing anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub record: MoveRecord,
    /// Message currently carrying the in-effect marker, before relocation.
    pub marker_carrier: String,
    /// The old compaction part id on `marker_carrier`, deleted by relocation.
    pub old_compaction_part: String,
    /// The old summary message id being relocated away from `marker_carrier`.
    pub old_summary: String,
    /// The old summary's text part id being deleted with it.
    pub old_summary_part: String,
    /// The old summary message `data` as stored now (before-image).
    pub old_summary_data: String,
    /// The old summary text part `data` as stored now (before-image).
    pub old_summary_part_data: String,
    /// The old summary's text, carried unchanged onto the new summary part.
    pub summary_text: String,
    /// The old summary message's `path.cwd`, carried onto the new summary.
    pub summary_cwd: String,
    /// The old summary message's `path.root`, carried onto the new summary.
    pub summary_root: String,
    /// The new summary message id at `U` (deterministic for `U` and `P`).
    pub new_summary_id: String,
    /// The new compaction part id on `U` (deterministic for `U` and `P`).
    pub new_compaction_part_id: String,
    /// The new summary text part id (deterministic for `U` and `P`).
    pub new_summary_part_id: String,
    /// `U`'s `time_created`, pinning the writer's ordering times.
    pub u_time: i64,
    /// Last counted message before U.
    pub p: String,
    /// Number of plugin-counted messages before U (P's 1-based position).
    pub message_count: usize,
    pub dropped_summaries: Vec<i64>,
    /// Previously folded messages U..=T, now returned raw.
    pub returned_raw: Vec<String>,
    /// The compaction part's `data` as stored now.
    pub marker_before: String,
    /// Whether the part already carries this exact checkpoint key (a rerun).
    pub marker_already_keyed: bool,
    /// Drop targets standalone recorded before the cut; summaries cover them.
    pub behind_cut: usize,
    /// Kept for plan-output compatibility; unresolvable parts on present messages refuse.
    pub missing: Vec<String>,
    /// Tags whose host message or queued tag row no longer exists.
    pub gone: Vec<u64>,
    /// Tags on content the host does not serve, such as ignored or empty text.
    pub not_served: Vec<u64>,
}

impl Plan {
    pub fn to_value(&self) -> Value {
        let applied = self
            .record
            .drops
            .iter()
            .filter(|drop| drop.kind == DropKind::Applied)
            .count();
        let mut modes = BTreeMap::<String, usize>::new();
        for drop in &self.record.drops {
            *modes
                .entry(drop.drop_mode.clone().unwrap_or_else(|| "full".into()))
                .or_default() += 1;
        }
        json!({
            "session": self.record.session,
            "tag_checkpoint": self.record.tag_checkpoint,
            "cut": self.record.cut,
            "U": self.record.cut,
            "P": self.p,
            "message_count": self.message_count,
            "imported_summaries": self.record.compartments.iter().map(|c| c.sequence).collect::<Vec<_>>(),
            "dropped_summaries": self.dropped_summaries,
            "returned_raw": self.returned_raw,
            "marker_part": self.record.marker_part,
            "marker_key": if self.marker_already_keyed { "present" } else { "to_write" },
            "marker_key_value": {"tag_checkpoint": self.record.tag_checkpoint, "session": self.record.session, "message_count": self.message_count},
            "compartments": self.record.compartments.len(),
            "coverage_end": self.record.compartments.last().map(|c| c.end_message_id.clone()),
            "drops": {
                "applied": applied,
                "queued": self.record.drops.len() - applied,
                "source_drop_modes": modes,
                "behind_cut": self.behind_cut,
                "missing": self.missing,
                "gone": self.gone,
                "not_served": self.not_served,
            },
            "record_key": move_record_key(&self.record.session),
            "carried": self.record.drops,
        })
    }
}

/// `session_meta`'s harness, counter, pending marker and persisted marker state.
type SessionMetaRow = (String, Option<i64>, Option<String>, Option<String>);

struct TagRow {
    number: u64,
    address: String,
    kind: String,
    status: String,
    drop_mode: Option<String>,
    owner: Option<String>,
}

/// Validate the imported side independently of cut selection so the selected
/// cut cannot publish a partial compartment or leave a hole before the cut.
fn imported_prefix_len(spans: &[(usize, usize)], u: usize) -> Result<usize, Refusal> {
    if u == 1 {
        return Err(Refusal::new(
            "empty_prefix",
            "U is the first counted message",
        ));
    }
    if spans.iter().any(|&(start, end)| start < u && u <= end) {
        return Err(Refusal::new("cut_straddled", "a summary crosses U"));
    }
    let imported = spans.iter().take_while(|&&(_, end)| end < u).count();
    if imported == 0 || spans[imported - 1].1 != u - 1 {
        return Err(Refusal::new(
            "prefix_end_mismatch",
            "the imported prefix must end at P = U - 1",
        ));
    }
    Ok(imported)
}

fn choose_cut<'a>(
    host: &'a HostSession,
    spans: &[(usize, usize)],
    t: usize,
    relocated_summary: &str,
) -> Result<&'a MessageRow, Refusal> {
    let mut adjacency_conflict = false;
    for message in host.messages.iter().rev() {
        let Some(&u) = host.position.get(&message.id) else {
            continue;
        };
        if u > t + 1
            || (u != t + 1 && !spans.iter().any(|&(start, _)| start == u))
            || message.role != "user"
        {
            continue;
        }
        let other = host
            .parts
            .get(&message.id)
            .into_iter()
            .flatten()
            .filter(|part| part.kind != "compaction")
            .collect::<Vec<_>>();
        if !other.is_empty() && other.iter().all(|part| part.synthetic) {
            continue;
        }
        if host.messages.iter().any(|neighbour| {
            neighbour.id != message.id
                // The selected marker's summary is replaced by the move. All
                // surviving rows, including other summaries, still constrain U.
                && neighbour.id != relocated_summary
                && neighbour.time >= message.time
                && neighbour.time <= message.time.saturating_add(1)
        }) {
            adjacency_conflict = true;
            continue;
        }
        return Ok(message);
    }
    Err(if adjacency_conflict {
        Refusal::new(
            "adjacency_conflict",
            "every eligible carrier has a neighbour at U.time or U.time + 1",
        )
    } else {
        Refusal::new(
            "no_eligible_cut",
            "no eligible user message at a summary start or T + 1",
        )
    })
}

/// Model the writer's ordering without generating ids or modifying SQL rows.
/// The old summary is reinserted after U; all other completed marker pairs survive.
fn check_projected_marker(
    host: &HostSession,
    old_cut: &str,
    old_summary: &str,
    old_part: &str,
    u: &MessageRow,
) -> Result<(), Refusal> {
    let mut projected = host.clone();
    projected
        .messages
        .retain(|message| message.id != old_summary);
    projected.parts.remove(old_summary);
    if let Some(parts) = projected.parts.get_mut(old_cut) {
        parts.retain(|part| part.id != old_part);
    }
    projected
        .parts
        .entry(u.id.clone())
        .or_default()
        .push(PartRow {
            id: old_part.into(),
            kind: "compaction".into(),
            call_id: None,
            blank_text: false,
            synthetic: false,
            taggable: false,
            not_served: true,
        });
    let mut summary = host
        .messages
        .iter()
        .find(|message| message.id == old_summary)
        .unwrap()
        .clone();
    summary.parent = Some(u.id.clone());
    summary.time = u.time + 1;
    projected.messages.push(summary);
    projected
        .messages
        .sort_by(|a, b| (a.time, &a.id).cmp(&(b.time, &b.id)));
    if !in_effect_marker(&projected).is_some_and(|(index, summary)| {
        projected.messages[index].id == u.id && summary.id == old_summary
    }) {
        return Err(Refusal::new(
            "marker_shadowed",
            "a surviving marker would be selected instead of the new marker at U",
        ));
    }
    Ok(())
}

/// Compute the move of `session` from the three stores, read-only.
pub fn plan(paths: &StorePaths, session: &str) -> Result<Plan, Refusal> {
    if session.trim() != session || session.is_empty() {
        return Err(Refusal::new(
            "session_not_found",
            "the session id must be nonempty without surrounding whitespace",
        ));
    }
    let context = open_read_only(&paths.context_db)?;
    if read_move_record_raw(&context, session)
        .map_err(sql)?
        .is_some()
    {
        return Err(Refusal::new(
            "already_moved",
            format!(
                "context.db already holds the moved record {}",
                move_record_key(session)
            ),
        ));
    }
    let meta: Option<SessionMetaRow> = context
        .query_row(
            "SELECT harness, counter, pending_compaction_marker_state, compaction_marker_state
               FROM session_meta WHERE session_id=?1",
            [session],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(sql)?;
    let Some((harness, counter, pending_marker, marker_state)) = meta else {
        return Err(Refusal::new(
            "not_standalone_opencode1",
            format!("context.db has no standalone session_meta row for {session}"),
        ));
    };
    if harness != HARNESS {
        return Err(Refusal::new(
            "not_standalone_opencode1",
            format!("the session is managed for harness {harness:?}, not OpenCode 1"),
        ));
    }
    if pending_marker
        .as_deref()
        .is_some_and(|state| !state.trim().is_empty())
    {
        return Err(Refusal::new(
            "marker_pending_not_in_effect",
            "standalone has a compaction marker it has not written yet; resume standalone so it \
             writes or clears it, stop it, then rerun",
        ));
    }
    let store = open_read_only(&paths.store_db)?;
    if table_exists(&store, "mc_async_compaction").map_err(sql)? {
        let existing: bool = store
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_async_compaction WHERE session=?1)",
                [session],
                |row| row.get(0),
            )
            .map_err(sql)?;
        if existing {
            return Err(Refusal::new(
                "destination_not_empty",
                "store.db already holds an async compaction record for this session",
            ));
        }
    }
    drop(store);

    let mut tags = Vec::new();
    {
        let mut statement = context
            .prepare(
                "SELECT tag_number, COALESCE(message_id,''), COALESCE(type,''), COALESCE(status,'active'),
                        drop_mode, tool_owner_message_id
                   FROM tags WHERE session_id=?1 AND harness=?2 AND tag_number IS NOT NULL",
            )
            .map_err(sql)?;
        let rows = statement
            .query_map(params![session, HARNESS], |row| {
                Ok(TagRow {
                    number: row.get::<_, i64>(0)?.max(0) as u64,
                    address: row.get(1)?,
                    kind: row.get(2)?,
                    status: row.get(3)?,
                    drop_mode: row.get(4)?,
                    owner: row.get(5)?,
                })
            })
            .map_err(sql)?;
        for row in rows {
            tags.push(row.map_err(sql)?);
        }
    }
    let highest_tag = tags.iter().map(|tag| tag.number).max().unwrap_or(0);
    let tag_checkpoint = (counter.unwrap_or(0).max(0) as u64).max(highest_tag);

    let mut pending = Vec::new();
    {
        let mut statement = context
            .prepare(
                "SELECT id, tag_id, COALESCE(operation,''), queued_at FROM pending_ops
                  WHERE session_id=?1 AND harness=?2 ORDER BY queued_at, id",
            )
            .map_err(sql)?;
        let rows = statement
            .query_map(params![session, HARNESS], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(sql)?;
        for row in rows {
            let (id, tag, operation, queued_at) = row.map_err(sql)?;
            if operation != "drop" {
                return Err(Refusal::new(
                    "queue_invalid",
                    format!("pending op {id} has operation {operation:?}; only drops convert"),
                ));
            }
            pending.push((tag.unwrap_or(0).max(0) as u64, queued_at));
        }
    }

    let mut compartment_rows = Vec::new();
    {
        let mut statement = context
            .prepare(
                "SELECT sequence, COALESCE(start_message_id,''), start_block_index,
                        COALESCE(end_message_id,''), end_block_index, title, content,
                        p1, p2, p3, p4, importance, episode_type, legacy, created_at
                   FROM compartments WHERE session_id=?1 AND harness=?2 ORDER BY sequence",
            )
            .map_err(sql)?;
        let rows = statement
            .query_map(params![session, HARNESS], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    (
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<String>>(10)?,
                    ),
                    (
                        row.get::<_, i64>(11)?,
                        row.get::<_, Option<String>>(12)?,
                        row.get::<_, i64>(13)?,
                        row.get::<_, i64>(14)?,
                    ),
                ))
            })
            .map_err(sql)?;
        for row in rows {
            compartment_rows.push(row.map_err(sql)?);
        }
    }
    drop(context);
    if compartment_rows.is_empty() {
        return Err(Refusal::new(
            "summaries_missing",
            "the session has no compartments; nothing summarized to import",
        ));
    }

    let opencode = open_read_only(&paths.opencode_db)?;
    let host = load_host_session(&opencode, session)?;
    let Some((cut_index, summary)) = in_effect_marker(&host) else {
        return Err(Refusal::new(
            "marker_missing",
            "opencode.db has no compaction marker in effect for the session",
        ));
    };
    if summary.provider.as_deref() != Some(STANDALONE_MARKER_PROVIDER) {
        return Err(Refusal::new(
            "marker_not_standalone",
            format!(
                "the marker in effect at {} was written by {:?}, not standalone Magic Context",
                host.messages[cut_index].id, summary.provider
            ),
        ));
    }
    let old_cut = host.messages[cut_index].id.clone();
    let cut = old_cut.clone();
    let summary_id = summary.id.clone();
    let marker_parts: Vec<&PartRow> = host.parts[&cut]
        .iter()
        .filter(|part| part.kind == "compaction")
        .collect();
    let [marker] = marker_parts.as_slice() else {
        return Err(Refusal::new(
            "marker_ambiguous",
            format!(
                "the boundary message {cut} holds {} compaction parts",
                marker_parts.len()
            ),
        ));
    };
    let marker_part = marker.id.clone();
    let state = marker_state
        .as_deref()
        .filter(|state| !state.trim().is_empty())
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|error| {
            Refusal::new(
                "marker_state_mismatch",
                format!("compaction_marker_state: {error}"),
            )
        })?;
    if let Some(state) = &state {
        // The boundary must name the host's current carrier. The summary and
        // part ids are checked after `U` is known: when the host already
        // carries the relocated triple (a rerun after the host COMMIT), the
        // stored ids are stale by design and must not refuse.
        if let Some(stored) = state.get("boundaryMessageId").and_then(Value::as_str) {
            if stored != cut.as_str() {
                return Err(Refusal::new(
                    "marker_state_mismatch",
                    format!(
                        "standalone recorded boundaryMessageId={stored} but opencode.db has {cut}"
                    ),
                ));
            }
        }
    }
    let marker_before: String = opencode
        .query_row("SELECT data FROM part WHERE id=?1", [&marker_part], |row| {
            row.get(0)
        })
        .map_err(sql)?;
    let marker_json: Value = serde_json::from_str(&marker_before)
        .map_err(|error| Refusal::new("marker_state_mismatch", error.to_string()))?;
    // A key naming another session means this host row belongs to a fork.
    // The expected 3-key comparison happens after `U` is known, against the
    // relocated part, not the old one being deleted. An old key with the same
    // session but a different checkpoint still refuses, so a stale checkpoint
    // is never silently replaced by relocation.
    if let Some(existing) = marker_json.get("cortexkit") {
        let named = existing.get("session").and_then(Value::as_str);
        if named.is_some_and(|named| named != session) {
            return Err(Refusal::new(
                "fork_unsupported",
                format!(
                    "the marker's checkpoint key names session {}; this session is a fork",
                    named.unwrap_or_default()
                ),
            ));
        }
        if existing.get("tag_checkpoint").and_then(Value::as_u64) != Some(tag_checkpoint) {
            return Err(Refusal::new(
                "checkpoint_conflict",
                format!(
                    "the marker already carries {existing}, expected checkpoint {tag_checkpoint}"
                ),
            ));
        }
    }
    // The old summary's text and path ride unchanged onto the new summary rows.
    // The old summary always carries one text part in the fixtures.
    let old_summary_data: String = opencode
        .query_row(
            "SELECT data FROM message WHERE id=?1 AND session_id=?2",
            params![summary_id, session],
            |row| row.get(0),
        )
        .map_err(sql)?;
    let old_summary_json: Value = serde_json::from_str(&old_summary_data)
        .map_err(|error| Refusal::new("marker_state_mismatch", error.to_string()))?;
    let summary_cwd = old_summary_json
        .pointer("/path/cwd")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let summary_root = old_summary_json
        .pointer("/path/root")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let mut summary_parts: Vec<(String, String)> = Vec::new();
    {
        let mut statement = opencode
            .prepare("SELECT id, data FROM part WHERE message_id=?1 AND session_id=?2 ORDER BY id")
            .map_err(sql)?;
        let rows = statement
            .query_map(params![summary_id, session], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql)?;
        for row in rows {
            summary_parts.push(row.map_err(sql)?);
        }
    }
    let mut old_summary_part = String::new();
    let mut old_summary_part_data = String::new();
    let mut summary_text = String::new();
    for (id, data) in &summary_parts {
        let value: Value = serde_json::from_str(data)
            .map_err(|error| Refusal::new("marker_state_mismatch", error.to_string()))?;
        if value.get("type").and_then(Value::as_str) == Some("text") {
            old_summary_part = id.clone();
            old_summary_part_data = data.clone();
            summary_text = value
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            break;
        }
    }

    // Admission uses counted positions; raw host indexes are only for marker selection.
    let mut compartments = Vec::new();
    let mut spans = Vec::new();
    for (sequence, start_id, start_block, end_id, end_block, text, rest) in compartment_rows {
        if start_block.is_some() || end_block.is_some() {
            return Err(Refusal::new(
                "block_index",
                format!("compartment {sequence} has a block index"),
            ));
        }
        if start_id.is_empty() || end_id.is_empty() {
            return Err(Refusal::new(
                "summary_id_missing",
                format!("compartment {sequence} has a missing endpoint id"),
            ));
        }
        for mid in [&start_id, &end_id] {
            if !host.position.contains_key(mid.as_str()) {
                return Err(Refusal::new(
                    "summary_endpoint_missing",
                    format!(
                        "compartment {sequence} endpoint {mid:?} is not a message of the session"
                    ),
                ));
            }
        }
        let start = host.position[&start_id];
        let end = host.position[&end_id];
        if start > end {
            return Err(Refusal::new(
                "summary_inverted",
                format!("compartment {sequence} starts after its end"),
            ));
        }
        spans.push((start, end));
        let (title, content, p1, p2, p3, p4) = text;
        let (importance, episode_type, legacy, created_at) = rest;
        compartments.push(ImportedCompartment {
            sequence,
            start_part: None,
            start_block: None,
            start_message_id: start_id,
            end_part: None,
            end_block: None,
            end_message_id: end_id,
            title,
            content,
            p1,
            p2,
            p3,
            p4,
            importance: importance as i32,
            episode_type,
            legacy: legacy as i32,
            created_at,
        });
    }
    if spans[0].0 != 1 {
        return Err(Refusal::new(
            "prefix_gap",
            "the first summary must start at position 1",
        ));
    }
    if spans.windows(2).any(|pair| pair[1].0 != pair[0].1 + 1) {
        return Err(Refusal::new(
            "prefix_not_tiled",
            "summaries overlap or leave a gap",
        ));
    }
    let target = state
        .as_ref()
        .and_then(|state| state["targetEndMessageId"].as_str());
    let t = target
        .and_then(|target| host.position.get(target))
        .copied()
        .ok_or_else(|| {
            Refusal::new(
                "fold_end_missing",
                "targetEndMessageId is not a counted message",
            )
        })?;
    if !spans.iter().any(|&(start, end)| start <= t && t <= end) {
        return Err(Refusal::new(
            "fold_end_uncovered",
            "T is not covered by a summary",
        ));
    }
    let carrier = choose_cut(&host, &spans, t, &summary_id)?;
    let cut = carrier.id.clone();
    let u = host.position[&cut];
    let imported = imported_prefix_len(&spans, u)?;
    let dropped_summaries = compartments[imported..]
        .iter()
        .map(|c| c.sequence)
        .collect();
    compartments.truncate(imported);
    let p = host
        .messages
        .iter()
        .find(|message| host.position.get(&message.id) == Some(&(u - 1)))
        .unwrap()
        .id
        .clone();
    let returned_raw = host
        .messages
        .iter()
        .filter(|message| {
            host.position
                .get(&message.id)
                .is_some_and(|&pos| u <= pos && pos <= t)
        })
        .map(|message| message.id.clone())
        .collect();
    // The certificate for `P` is taken before apply, so apply must never
    // rewrite `P`'s rows. Relocating a marker whose carrier `W` is `P` would
    // delete `P`'s compaction part. Refuse before any write.
    if old_cut == p {
        return Err(Refusal::new(
            "marker_on_head_cut",
            format!(
                "the marker carrier {old_cut} is P, the certified head-cut message; relocating it would rewrite P"
            ),
        ));
    }
    check_projected_marker(&host, &old_cut, &summary_id, &marker_part, carrier)?;
    // The relocated triple, deterministic for this session, `P` and `U`'s time.
    // The generator's time/counter pairs are `(U.time + 1, 1)` for the summary
    // message, `(U.time, 1)` for the compaction part and `(U.time + 1, 2)` for
    // the summary text part, exactly as the plugin's writer uses them.
    let u_time = carrier.time;
    let marker_identity = format!("{session}\0{p}");
    let new_summary_id = generate_message_id(
        u_time.saturating_add(1),
        1,
        &format!("{marker_identity}\0summary-message"),
    );
    let new_compaction_part_id =
        generate_part_id(u_time, 1, &format!("{marker_identity}\0compaction-part"));
    let new_summary_part_id = generate_part_id(
        u_time.saturating_add(1),
        2,
        &format!("{marker_identity}\0summary-part"),
    );
    // When the host does not yet carry the relocated triple, the stored
    // summary and part ids must still name it. Once the host carries the new
    // triple (a rerun after the host COMMIT), the stored ids are stale and
    // the check is skipped.
    if marker_part != new_compaction_part_id || summary_id != new_summary_id {
        if let Some(state) = &state {
            for (field, expected) in [
                ("compactionPartId", marker_part.as_str()),
                ("summaryMessageId", summary_id.as_str()),
            ] {
                if let Some(stored) = state.get(field).and_then(Value::as_str) {
                    if stored != expected {
                        return Err(Refusal::new(
                            "marker_state_mismatch",
                            format!(
                                "standalone recorded {field}={stored} but opencode.db has {expected}"
                            ),
                        ));
                    }
                }
            }
        }
    }
    // Each imported endpoint's CK block id, computed offline with the same
    // codec `edge_block` uses, over the host message. Whole-message endpoints
    // cover the first through the last decoded CK block.
    let codec_profile = offline_codec_profile();
    for compartment in &mut compartments {
        for (mid, is_start) in [
            (compartment.start_message_id.clone(), true),
            (compartment.end_message_id.clone(), false),
        ] {
            let role = host
                .messages
                .iter()
                .find(|message| message.id == mid)
                .map(|message| message.role.clone())
                .unwrap_or_default();
            let part_datas = host_part_datas(&opencode, session, &mid)?;
            let range = offline_ck_block_range(&role, &part_datas);
            match (is_start, range) {
                (true, Some((first, _))) => compartment.start_block = Some(first),
                (false, Some((_, last))) => compartment.end_block = Some(last),
                _ => {}
            }
        }
    }
    // The relocated part already carries this exact 3-key when a previous
    // apply relocated the rows but stopped before the moved record. The old
    // part's key is irrelevant: it is deleted with the old triple. A relocated
    // part carrying a different session is a fork; one carrying the same
    // session but a different checkpoint refuses, so a stale key is never
    // kept.
    let expected_key = json!({
        "tag_checkpoint": tag_checkpoint,
        "session": session,
        "message_count": u - 1,
    });
    if let Some(existing) = opencode
        .query_row(
            "SELECT data FROM part WHERE id=?1 AND session_id=?2",
            params![new_compaction_part_id, session],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql)?
        .and_then(|data| serde_json::from_str::<Value>(&data).ok())
        .and_then(|data| data.get("cortexkit").cloned())
    {
        let named = existing.get("session").and_then(Value::as_str);
        if named.is_some_and(|named| named != session) {
            return Err(Refusal::new(
                "fork_unsupported",
                format!(
                    "the relocated marker's checkpoint key names session {}; this session is a fork",
                    named.unwrap_or_default()
                ),
            ));
        }
        if existing != expected_key {
            return Err(Refusal::new(
                "checkpoint_conflict",
                format!(
                    "the relocated marker already carries {existing}, expected checkpoint {tag_checkpoint}"
                ),
            ));
        }
    }
    let marker_already_keyed = opencode
        .query_row(
            "SELECT data FROM part WHERE id=?1 AND session_id=?2",
            params![new_compaction_part_id, session],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql)?
        .and_then(|data| serde_json::from_str::<Value>(&data).ok())
        .and_then(|data| data.get("cortexkit").cloned())
        .is_some_and(|key| key == expected_key);

    // Drops: resolve every target after the cut to its OpenCode part.
    let by_number: HashMap<u64, &TagRow> = tags.iter().map(|tag| (tag.number, tag)).collect();
    let mut targets: Vec<(u64, DropKind, Option<i64>)> = tags
        .iter()
        .filter(|tag| tag.status == "dropped")
        .map(|tag| (tag.number, DropKind::Applied, None))
        .collect();
    let applied: HashSet<u64> = targets.iter().map(|(number, _, _)| *number).collect();
    let mut queued_seen = HashSet::new();
    for (number, queued_at) in &pending {
        if !applied.contains(number) && queued_seen.insert(*number) {
            targets.push((*number, DropKind::Queued, *queued_at));
        }
    }
    let by_mid: HashMap<&str, &MessageRow> = host
        .messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect();
    let after_cut = |mid: &str| {
        by_mid
            .get(mid)
            .map(|message| (message.time, &message.id) >= (carrier.time, &carrier.id))
    };
    let mut positional: HashMap<&str, Vec<(PositionalKind, usize, u64)>> = HashMap::new();
    for tag in &tags {
        if tag.kind == "message" || tag.kind == "file" {
            if let Some((mid, kind, index)) = parse_positional(&tag.address) {
                positional
                    .entry(mid)
                    .or_default()
                    .push((kind, index, tag.number));
            }
        }
    }
    let mut resolved_messages: HashMap<String, HashMap<u64, String>> = HashMap::new();
    let mut tool_parts: HashMap<&str, Vec<(&str, &str)>> = HashMap::new();
    for message in &host.messages {
        for part in host.parts.get(&message.id).into_iter().flatten() {
            if part.kind == "tool" {
                if let Some(call) = &part.call_id {
                    tool_parts
                        .entry(call.as_str())
                        .or_default()
                        .push((message.id.as_str(), part.id.as_str()));
                }
            }
        }
    }
    let mut drops = Vec::new();
    let mut behind_cut = 0;
    let missing = Vec::new();
    let mut gone = Vec::new();
    let mut not_served = Vec::new();
    let mut carried_parts = HashSet::new();
    for (number, kind, queued_at) in targets {
        let Some(tag) = by_number.get(&number) else {
            gone.push(number);
            continue;
        };
        let located = match tag.kind.as_str() {
            "message" | "file" => {
                let Some((mid, _, index)) = parse_positional(&tag.address) else {
                    return Err(Refusal::new(
                        "address_malformed",
                        format!("tag {number} has address {:?}", tag.address),
                    ));
                };
                match after_cut(mid) {
                    None => {
                        gone.push(number);
                        continue;
                    }
                    Some(false) => {
                        behind_cut += 1;
                        continue;
                    }
                    Some(true) if !by_mid[mid].counted => {
                        not_served.push(number);
                        continue;
                    }
                    // A positional slot past the message's last part is gone:
                    // nothing at that slot is served (CKDESK's second tag at
                    // `:p1` on a one-text-part user message was an id-less part
                    // another plugin added in memory). Only a part that exists
                    // at or after `U` but cannot be mapped refuses missing.
                    Some(true)
                        if host
                            .parts
                            .get(mid)
                            .map(|parts| index >= parts.len())
                            .unwrap_or(true) =>
                    {
                        gone.push(number);
                        continue;
                    }
                    Some(true) => resolved_messages
                        .entry(mid.to_owned())
                        .or_insert_with(|| {
                            resolve_positional_tags(
                                host.parts.get(mid).map(Vec::as_slice).unwrap_or(&[]),
                                positional.get(mid).map(Vec::as_slice).unwrap_or(&[]),
                            )
                        })
                        .get(&number)
                        .map(|part| (mid.to_owned(), part.clone()))
                        // An unnumbered part at the exact slot can explain a
                        // refusal, but must not rebind a text drop to tool output.
                        .or_else(|| {
                            host.parts
                                .get(mid)
                                .and_then(|parts| parts.get(index))
                                .filter(|part| {
                                    !matches!(part.kind.as_str(), "text" | "file" | "compaction")
                                        && !part.taggable
                                })
                                .map(|part| (mid.to_owned(), part.id.clone()))
                        }),
                }
            }
            "tool" => {
                if let Some(owner) = tag.owner.as_deref() {
                    if !by_mid.contains_key(owner) {
                        gone.push(number);
                        continue;
                    }
                    if after_cut(owner) == Some(true) && !by_mid[owner].counted {
                        not_served.push(number);
                        continue;
                    }
                }
                if tag
                    .owner
                    .as_deref()
                    .is_some_and(|owner| after_cut(owner) == Some(false))
                {
                    behind_cut += 1;
                    continue;
                }
                let candidates: Vec<&(&str, &str)> = tool_parts
                    .get(tag.address.as_str())
                    .into_iter()
                    .flatten()
                    .filter(|(mid, _)| tag.owner.as_deref().is_none_or(|owner| owner == *mid))
                    .collect();
                if !candidates.is_empty()
                    && candidates
                        .iter()
                        .all(|(mid, _)| after_cut(mid) == Some(false))
                {
                    behind_cut += 1;
                    continue;
                }
                if candidates.len() > 1 {
                    return Err(Refusal::new(
                        "drop_target_ambiguous",
                        format!(
                            "tag {number}: call {} (owner {:?}) matches {} tool parts",
                            tag.address,
                            tag.owner,
                            candidates.len()
                        ),
                    ));
                }
                match candidates.first() {
                    None if tag.owner.is_none() => {
                        gone.push(number);
                        continue;
                    }
                    None => None,
                    Some((mid, _)) if after_cut(mid) == Some(false) => {
                        behind_cut += 1;
                        continue;
                    }
                    Some((mid, _)) if !by_mid[*mid].counted => {
                        not_served.push(number);
                        continue;
                    }
                    Some((mid, part)) => Some(((*mid).to_owned(), (*part).to_owned())),
                }
            }
            other => {
                return Err(Refusal::new(
                    "address_malformed",
                    format!("tag {number} has unknown type {other:?}"),
                ))
            }
        };
        let Some((mid, part)) = located else {
            return Err(Refusal::new(
                "drop_target_missing",
                format!("tag {number} at {:?} cannot be resolved", tag.address),
            ));
        };
        if host
            .parts
            .get(&mid)
            .into_iter()
            .flatten()
            .any(|row| row.id == part && row.not_served)
        {
            not_served.push(number);
            continue;
        }
        if !carried_parts.insert((mid.clone(), part.clone())) {
            return Err(Refusal::new(
                "drop_target_ambiguous",
                format!("tag {number} resolves to part {part} of {mid}, already carried for another tag"),
            ));
        }
        if !host
            .parts
            .get(&mid)
            .into_iter()
            .flatten()
            .any(|row| row.id == part && row.taggable)
        {
            return Err(Refusal::new(
                "drop_target_untagged",
                format!("part {part} of {mid} cannot carry a runner tag"),
            ));
        }
        drops.push(CarriedDrop {
            mid,
            part,
            kind,
            source_tag: number,
            drop_mode: (kind == DropKind::Applied)
                .then(|| tag.drop_mode.clone())
                .flatten(),
            queued_at_ms: queued_at,
        });
    }
    drops.sort_by(|a, b| (a.source_tag, &a.mid, &a.part).cmp(&(b.source_tag, &b.mid, &b.part)));
    gone.sort_unstable();
    gone.dedup();
    not_served.sort_unstable();
    not_served.dedup();
    Ok(Plan {
        marker_carrier: old_cut.clone(),
        old_compaction_part: marker_part.clone(),
        old_summary: summary_id.clone(),
        old_summary_part,
        summary_text,
        summary_cwd,
        summary_root,
        new_summary_id,
        new_compaction_part_id: new_compaction_part_id.clone(),
        new_summary_part_id,
        u_time,
        record: MoveRecord {
            version: RECORD_VERSION,
            session: session.to_owned(),
            harness: HARNESS.to_owned(),
            tag_checkpoint,
            cut,
            marker_part: new_compaction_part_id,
            codec_profile,
            compartments,
            drops,
        },
        p,
        message_count: u - 1,
        dropped_summaries,
        returned_raw,
        marker_before,
        old_summary_data,
        old_summary_part_data,
        marker_already_keyed,
        behind_cut,
        missing,
        gone,
        not_served,
    })
}

// ── Writing ──────────────────────────────────────────────────────────────

/// A point after which a test stops the move, as a crash would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopAfter {
    /// The checkpoint key is on the marker; the moved record is not written.
    MarkerKey,
}

#[derive(Debug)]
pub enum MoveError {
    Refused(Refusal),
    /// A write failed or a test stopped the move; rerunning resumes it.
    Interrupted(String),
}

impl From<Refusal> for MoveError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

const WRITE_BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

fn open_writer(path: &Path) -> Result<Connection, MoveError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|error| MoveError::Interrupted(format!("{}: {error}", path.display())))?;
    conn.busy_timeout(WRITE_BUSY_TIMEOUT)
        .map_err(|error| MoveError::Interrupted(error.to_string()))?;
    Ok(conn)
}

fn interrupted(step: &str) -> impl Fn(rusqlite::Error) -> MoveError + '_ {
    move |error| MoveError::Interrupted(format!("{step}: {error}"))
}

/// The relocated compaction part's checkpoint key, in the plugin's member
/// order (`tag_checkpoint`, `session`, `message_count`).
#[derive(Serialize)]
struct RelocatedCheckpointKey<'a> {
    tag_checkpoint: u64,
    session: &'a str,
    message_count: usize,
}

/// The relocated compaction part's `data`: the plugin's
/// `{"type":"compaction","auto":true}` with `cortexkit` appended last.
/// A struct (field order is declaration order), never `json!`, so the bytes
/// match the plugin's `JSON.stringify` insertion order.
#[derive(Serialize)]
struct RelocatedCompactionData<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    auto: bool,
    cortexkit: RelocatedCheckpointKey<'a>,
}

#[derive(Serialize)]
struct RelocatedPath<'a> {
    cwd: &'a str,
    root: &'a str,
}

#[derive(Serialize)]
struct RelocatedCache {
    read: u8,
    write: u8,
}

#[derive(Serialize)]
struct RelocatedTokens {
    input: u8,
    output: u8,
    reasoning: u8,
    cache: RelocatedCache,
}

#[derive(Serialize)]
struct RelocatedTime {
    created: i64,
    completed: i64,
}

/// The relocated summary message's `data`: the plugin writer's output for
/// `resolvedBoundary = U` and `endMessageId = P`, with the old summary's path
/// carried over. Field order is declaration order, matching the plugin's
/// `JSON.stringify` member order exactly.
#[derive(Serialize)]
struct RelocatedSummaryData<'a> {
    role: &'a str,
    #[serde(rename = "parentID")]
    parent_id: &'a str,
    summary: bool,
    finish: &'a str,
    mode: &'a str,
    agent: &'a str,
    path: RelocatedPath<'a>,
    cost: u8,
    tokens: RelocatedTokens,
    #[serde(rename = "modelID")]
    model_id: &'a str,
    #[serde(rename = "providerID")]
    provider_id: &'a str,
    time: RelocatedTime,
}

/// The relocated compaction part's `data`: the plugin's
/// `{"type":"compaction","auto":true}` plus exactly the `cortexkit` key.
fn relocation_compaction_data(tag_checkpoint: u64, session: &str, message_count: usize) -> String {
    serde_json::to_string(&RelocatedCompactionData {
        kind: "compaction",
        auto: true,
        cortexkit: RelocatedCheckpointKey {
            tag_checkpoint,
            session,
            message_count,
        },
    })
    .expect("compaction data serializes")
}

/// The relocated summary message's `data`: the plugin writer's output for
/// `resolvedBoundary = U` and `endMessageId = P`, with the old summary's path
/// carried over. Key order matches the plugin's `JSON.stringify` exactly.
fn relocation_summary_data(boundary_id: &str, boundary_time: i64, cwd: &str, root: &str) -> String {
    let time = boundary_time.saturating_add(1);
    serde_json::to_string(&RelocatedSummaryData {
        role: "assistant",
        parent_id: boundary_id,
        summary: true,
        finish: "stop",
        mode: "compaction",
        agent: "compaction",
        path: RelocatedPath { cwd, root },
        cost: 0,
        tokens: RelocatedTokens {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: RelocatedCache { read: 0, write: 0 },
        },
        model_id: "magic-context",
        provider_id: "magic-context",
        time: RelocatedTime {
            created: time,
            completed: time,
        },
    })
    .expect("summary data serializes")
}

/// Write the plan: the three-row relocation and the checkpoint key in one host
/// transaction on `opencode.db`, then the moved record last in `context.db`.
/// The relocation deletes the old triple and inserts the new triple (with the
/// 3-key) atomically; rerunning after the host COMMIT but before the record
/// finds the new rows already in place and only writes the record.
pub fn apply(paths: &StorePaths, plan: &Plan, stop: Option<StopAfter>) -> Result<(), MoveError> {
    let record = &plan.record;
    let new_compaction_data =
        relocation_compaction_data(record.tag_checkpoint, &record.session, plan.message_count);
    let new_summary_data = relocation_summary_data(
        &record.cut,
        plan.u_time,
        &plan.summary_cwd,
        &plan.summary_root,
    );
    // The summary text is unchanged by the move: copy the old summary part's
    // `data` string verbatim, keeping `JSON.stringify`'s exact escaping.
    let new_summary_part_data = plan.old_summary_part_data.clone();
    let summary_time = plan.u_time.saturating_add(1);
    if !plan.marker_already_keyed {
        let mut opencode = open_writer(&paths.opencode_db)?;
        // A generated marker id that is already taken by an unrelated row has
        // no refusal code yet: stop and ask rather than inventing one or
        // overwriting the row. The check runs before the host transaction, so
        // nothing is written when it fires.
        for (id, expected, what) in [
            (
                &plan.new_summary_id,
                new_summary_data.as_str(),
                "summary message",
            ),
            (
                &plan.new_compaction_part_id,
                new_compaction_data.as_str(),
                "compaction part",
            ),
            (
                &plan.new_summary_part_id,
                new_summary_part_data.as_str(),
                "summary text part",
            ),
        ] {
            let taken: Option<(String, String, i64, i64)> = opencode
                .query_row(
                    "SELECT message_id, session_id, time_created, time_updated FROM part WHERE id=?1 \
                     UNION ALL SELECT id, session_id, time_created, time_updated FROM message WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()
                .map_err(interrupted("opencode.db taken id probe"))?;
            // A row with one of the new ids is only expected when it is the
            // relocated row itself (a rerun after the host COMMIT) or one of
            // the old rows being replaced (ids never collide in practice, but
            // the old triple is deleted in the same transaction).
            if taken.is_some() {
                let existing_data: Option<String> = opencode
                    .query_row(
                        "SELECT data FROM part WHERE id=?1 UNION ALL SELECT data FROM message WHERE id=?1",
                        [id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(interrupted("opencode.db taken id data"))?;
                let is_old = id == &plan.old_compaction_part
                    || id == &plan.old_summary
                    || id == &plan.old_summary_part;
                if existing_data.as_deref() != Some(expected) && !is_old {
                    return Err(MoveError::Interrupted(format!(
                        "generated marker {what} id {id} is already taken; manual resolution is required"
                    )));
                }
            }
            let _ = what;
        }
        let tx = opencode
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(interrupted("opencode.db"))?;
        // Rerun after the host COMMIT: the old rows are gone and the new rows
        // already carry the expected bytes. Skip the relocation and only write
        // the moved record below.
        let old_gone: bool = tx
            .query_row(
                "SELECT NOT EXISTS(SELECT 1 FROM message WHERE id=?1) \
                 AND NOT EXISTS(SELECT 1 FROM part WHERE id=?2 OR id=?3)",
                params![
                    plan.old_summary,
                    plan.old_compaction_part,
                    plan.old_summary_part
                ],
                |row| row.get(0),
            )
            .map_err(interrupted("opencode.db relocation probe"))?;
        let new_ok = |id: &str, expected: &str| -> Result<bool, MoveError> {
            Ok(tx
                .query_row(
                    "SELECT data FROM message WHERE id=?1 UNION ALL SELECT data FROM part WHERE id=?1",
                    [id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(interrupted("opencode.db relocation probe"))?
                .as_deref()
                == Some(expected))
        };
        let already = old_gone
            && new_ok(&plan.new_summary_id, &new_summary_data)?
            && new_ok(&plan.new_compaction_part_id, &new_compaction_data)?
            && new_ok(&plan.new_summary_part_id, &new_summary_part_data)?;
        if !already {
            // Fail closed when the host changed since planning: the old rows
            // must still carry their before-images, otherwise a rerun is
            // required to plan again. The compare is by `data`; times and ids
            // are pinned by the relocation itself.
            let old_ok = |id: &str, expected: &str| -> Result<bool, MoveError> {
                Ok(tx
                    .query_row(
                        "SELECT data FROM message WHERE id=?1 UNION ALL SELECT data FROM part WHERE id=?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .map_err(interrupted("opencode.db relocation probe"))?
                    .as_deref()
                    == Some(expected))
            };
            if !(old_ok(&plan.old_compaction_part, &plan.marker_before)?
                && old_ok(&plan.old_summary, &plan.old_summary_data)?
                && (plan.old_summary_part.is_empty()
                    || old_ok(&plan.old_summary_part, &plan.old_summary_part_data)?))
            {
                return Err(Refusal::new(
                    "source_changed",
                    "the host marker changed after planning; rerun to plan again",
                )
                .into());
            }
            // One host transaction: delete the old triple, insert the new
            // triple with the checkpoint key. The upserts make a rerun that
            // stopped after a partial write converge on the same bytes.
            tx.execute(
                "DELETE FROM part WHERE id=?1 OR id=?2",
                params![plan.old_compaction_part, plan.old_summary_part],
            )
            .map_err(interrupted("opencode.db delete old parts"))?;
            tx.execute(
                "DELETE FROM message WHERE id=?1",
                [plan.old_summary.as_str()],
            )
            .map_err(interrupted("opencode.db delete old summary"))?;
            tx.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id=excluded.message_id, session_id=excluded.session_id,
                     time_created=excluded.time_created, time_updated=excluded.time_updated,
                     data=excluded.data",
                params![
                    plan.new_compaction_part_id,
                    record.cut,
                    record.session,
                    plan.u_time,
                    plan.u_time,
                    new_compaction_data,
                ],
            )
            .map_err(interrupted("opencode.db insert compaction part"))?;
            tx.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     session_id=excluded.session_id, time_created=excluded.time_created,
                     time_updated=excluded.time_updated, data=excluded.data",
                params![
                    plan.new_summary_id,
                    record.session,
                    summary_time,
                    summary_time,
                    new_summary_data,
                ],
            )
            .map_err(interrupted("opencode.db insert summary"))?;
            tx.execute(
                "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     message_id=excluded.message_id, session_id=excluded.session_id,
                     time_created=excluded.time_created, time_updated=excluded.time_updated,
                     data=excluded.data",
                params![
                    plan.new_summary_part_id,
                    plan.new_summary_id,
                    record.session,
                    summary_time,
                    summary_time,
                    new_summary_part_data,
                ],
            )
            .map_err(interrupted("opencode.db insert summary part"))?;
        }
        tx.commit().map_err(interrupted("opencode.db commit"))?;
    }
    if stop == Some(StopAfter::MarkerKey) {
        return Err(MoveError::Interrupted(
            "stopped after the marker key".into(),
        ));
    }
    let mut context = open_writer(&paths.context_db)?;
    let tx = context
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(interrupted("context.db"))?;
    let value =
        serde_json::to_string(record).map_err(|error| MoveError::Interrupted(error.to_string()))?;
    // A plain insert: an existing record is someone else's commit, never overwritten.
    tx.execute(
        "INSERT INTO schema_migrations_meta(key, value) VALUES (?1, ?2)",
        params![move_record_key(&record.session), value],
    )
    .map_err(interrupted("context.db moved record"))?;
    tx.commit().map_err(interrupted("context.db commit"))?;
    Ok(())
}

/// Outcome of one `move-session` run.
#[derive(Debug)]
pub enum Outcome {
    Planned(Plan),
    Moved(Plan),
}

/// Check, plan and (unless `dry_run`) write the move of `session`.
pub fn run(
    paths: &StorePaths,
    session: &str,
    dry_run: bool,
    holders: &dyn HolderCheck,
    stop: Option<StopAfter>,
) -> Result<Outcome, MoveError> {
    check_holders(paths, holders)?;
    let plan = plan(paths, session)?;
    if dry_run {
        return Ok(Outcome::Planned(plan));
    }
    apply(paths, &plan, stop)?;
    Ok(Outcome::Moved(plan))
}

const USAGE: &str = "usage: ck-mc offline move-session --session <id> --opencode-db <path> \
     --context-db <path> --store-db <path> [--plan | --dry-run]";

fn parse_args(args: &[String]) -> Result<(StorePaths, String, bool), String> {
    let mut session = None;
    let (mut opencode_db, mut context_db, mut store_db) = (None, None, None);
    let mut dry_run = false;
    let mut iter = args.iter();
    match iter.next().map(String::as_str) {
        Some("move-session") => {}
        _ => return Err(USAGE.into()),
    }
    while let Some(arg) = iter.next() {
        let mut value = || {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("{arg} needs a value"))
        };
        match arg.as_str() {
            "--session" => session = Some(value()?),
            "--opencode-db" => opencode_db = Some(PathBuf::from(value()?)),
            "--context-db" => context_db = Some(PathBuf::from(value()?)),
            "--store-db" => store_db = Some(PathBuf::from(value()?)),
            "--plan" | "--dry-run" => dry_run = true,
            other => return Err(format!("unknown argument {other:?}; {USAGE}")),
        }
    }
    match (session, opencode_db, context_db, store_db) {
        (Some(session), Some(opencode_db), Some(context_db), Some(store_db)) => Ok((
            StorePaths {
                opencode_db,
                context_db,
                store_db,
            },
            session,
            dry_run,
        )),
        _ => Err(USAGE.into()),
    }
}

/// `ck-mc offline <args>`: prints one JSON object on stdout and a one-line verdict
/// on stderr. Exit 0 when moved or planned, 2 when refused, 1 when interrupted.
pub fn cli_main(args: &[String]) -> i32 {
    if args.first().map(String::as_str) == Some("first-pass") {
        return crate::offline_first_pass::cli_main(&args[1..]);
    }
    let (paths, session, dry_run) = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(usage) => {
            println!(
                "{}",
                json!({"status":"refused","refusal":{"code":"usage","detail":usage}})
            );
            return 2;
        }
    };
    match run(&paths, &session, dry_run, &Lsof, None) {
        Ok(Outcome::Planned(plan)) => {
            println!("{}", json!({"status":"dry_run","plan":plan.to_value()}));
            eprintln!("SESSION PLANNED {session}: no store was written");
            0
        }
        Ok(Outcome::Moved(plan)) => {
            println!("{}", json!({"status":"moved","plan":plan.to_value()}));
            eprintln!(
                "SESSION MOVED {session} checkpoint={} cut={}",
                plan.record.tag_checkpoint, plan.record.cut
            );
            0
        }
        Err(MoveError::Refused(refusal)) => {
            println!(
                "{}",
                json!({"status":"refused","session":session,"refusal":{"code":refusal.code,"detail":refusal.detail}})
            );
            eprintln!(
                "SESSION REFUSED {session} code={}: {}. Not moved; the session stays on standalone.",
                refusal.code, refusal.detail
            );
            2
        }
        Err(MoveError::Interrupted(reason)) => {
            println!(
                "{}",
                json!({"status":"interrupted","session":session,"error":reason})
            );
            eprintln!(
                "SESSION INCOMPLETE {session}: {reason}. Rerun the same command to finish, or restore the window's backups."
            );
            1
        }
    }
}

#[cfg(test)]
#[path = "offline_move_tests.rs"]
pub(crate) mod tests;
