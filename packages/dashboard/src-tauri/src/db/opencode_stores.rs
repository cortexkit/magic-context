//! Which OpenCode stores the dashboard reads, and how it opens one.
//!
//! A store is one `opencode.db` file. The dashboard reads an ordered list of
//! them and merges what it finds:
//!
//! 1. the user's own store, resolved exactly as before:
//!    - `OPENCODE_DB`, when set, names the file (a relative path is taken
//!      from `<data home>/opencode/`);
//!    - else OpenCode's release channel decides the file name. Each channel
//!      of an OpenCode build (`dev`, `local`, a nightly and so on) keeps its
//!      own `opencode-<channel>.db`, while `latest`, `beta` and `prod` share
//!      `opencode.db`. `OPENCODE_CHANNEL` names the channel, and
//!      `OPENCODE_DISABLE_CHANNEL_DB=1` (or `true`) forces `opencode.db`;
//!    - with neither variable set, the most recently written `opencode.db`
//!      or `opencode-<channel>.db` in `<data home>/opencode/` is used;
//! 2. the stores the CortexKit runner publishes in
//!    `<data home>/cortexkit/thalamus-harness/opencode-sessions/roots.json`,
//!    one per root, each root's `path` being the folder that holds
//!    `opencode.db`;
//! 3. the paths listed in the user config under
//!    `dashboard.opencode_db_paths`, each an `opencode.db` file or a folder
//!    holding one.
//!
//! A file listed twice (same device and inode, or the same canonical path
//! where the platform has no inode) is read once, under its first listing. A
//! listed path that is missing or refused is shown in the Config screen and
//! skipped by every reader; it never fails the dashboard.
//!
//! Every store belongs to another process (OpenCode, or the runner's shared
//! OpenCode 2 server), so readers follow that owner's rules:
//!
//! - Open read-only. Never write, never checkpoint, and turn off the
//!   checkpoint SQLite would otherwise attempt when a connection closes.
//! - When both `-wal` and `-shm` exist, the owner is running (or stopped
//!   without cleaning up): open normally. Never `immutable=1` then, because
//!   committed rows still in the WAL would be invisible.
//! - When neither exists, the owner is stopped: open `immutable=1`, so SQLite
//!   creates no `-wal`/`-shm` files in the owner's folder, and check after the
//!   read that the file did not change meanwhile; a read that saw a change is
//!   discarded.
//! - When exactly one exists, the store is in a state we cannot read without
//!   changing it: skip it and say why.
//! - Never keep a read transaction or a half-read statement open between
//!   calls: an open read snapshot stops the owner's checkpoint, and the
//!   runner's store is several gigabytes.

use super::{resolve_opencode_db_for, OpenCodeDbOverrides};
use crate::broca_wal::file_identity;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

/// The `owner_principal` the runner records for sessions Magic Context's own
/// module owns there (its summarizer runs). Those sessions are helpers, not
/// conversations, so the dashboard flags them like subagents.
pub(crate) const RUNNER_HELPER_OWNER: &str = "magic-context";

/// The `roots.json` format this reader understands.
const RUNNER_ROOTS_VERSION: u64 = 1;

/// Where a listed store came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreOrigin {
    Default,
    Runner,
    Configured,
}

/// One row of the store list as the Config screen shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenCodeStoreRow {
    pub path: String,
    pub origin: StoreOrigin,
    /// The file exists.
    pub found: bool,
    /// Readers read this store. False for a missing, refused or duplicate
    /// row, and for a store whose WAL files are in a state we must not open.
    pub read: bool,
    /// Why the row is not read, in words for the user.
    pub note: Option<String>,
    /// For a configured row, the value exactly as written in the config, so
    /// the editor can remove that entry.
    pub configured_value: Option<String>,
}

/// A store the readers open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadableStore {
    pub path: PathBuf,
    pub origin: StoreOrigin,
    /// Sessions this store's `roots.json` entry says Magic Context owns.
    helpers: Arc<HashSet<String>>,
}

impl ReadableStore {
    #[cfg(test)]
    pub(crate) fn for_tests(path: PathBuf) -> Self {
        Self {
            path,
            origin: StoreOrigin::Default,
            helpers: Arc::default(),
        }
    }

    /// Whether this store marks `session_id` as one of Magic Context's own
    /// helper sessions. This is the only rule that hides a session because of
    /// the store it lives in; OpenCode's `parent_id` and Magic Context's
    /// `is_subagent` flag sessions in every store as before.
    ///
    /// Only runner stores carry helpers: the runner records which module owns
    /// each session, and `RUNNER_HELPER_OWNER` is Magic Context's own module.
    /// A session the runner does not list, or lists under another owner, is
    /// never flagged here: absence from `roots.json` must not hide a session.
    pub(crate) fn flags_as_helper(&self, session_id: &str) -> bool {
        self.origin == StoreOrigin::Runner && self.helpers.contains(session_id)
    }

    /// Every session `flags_as_helper` flags in this store.
    pub(crate) fn helper_session_ids(&self) -> impl Iterator<Item = &str> + '_ {
        self.helpers
            .iter()
            .map(String::as_str)
            .filter(|id| self.flags_as_helper(id))
    }
}

/// One store the runner publishes in `roots.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RunnerRoot {
    pub store: PathBuf,
    pub helpers: Arc<HashSet<String>>,
}

/// What `roots.json` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunnerRoots {
    /// No file: the runner is not installed or has published nothing.
    Absent,
    /// A file this reader cannot use. It means "no runner stores"; the text
    /// says why and is logged once.
    Unusable(String),
    Roots(Vec<RunnerRoot>),
}

pub(crate) fn runner_roots_path(data_home: &Path) -> PathBuf {
    data_home
        .join("cortexkit")
        .join("thalamus-harness")
        .join("opencode-sessions")
        .join("roots.json")
}

/// Reads `roots.json` tolerantly: fields this reader does not know are
/// ignored, and a root without an absolute `path` is skipped.
pub(crate) fn parse_runner_roots(path: &Path) -> RunnerRoots {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return RunnerRoots::Absent,
        Err(error) => {
            return RunnerRoots::Unusable(format!("cannot read {}: {error}", path.display()))
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            return RunnerRoots::Unusable(format!("{} is not valid JSON: {error}", path.display()))
        }
    };
    let version = value.get("version");
    if version.and_then(serde_json::Value::as_u64) != Some(RUNNER_ROOTS_VERSION) {
        return RunnerRoots::Unusable(format!(
            "{} has version {}, and this dashboard reads version {RUNNER_ROOTS_VERSION}",
            path.display(),
            version.map_or_else(|| "none".to_string(), ToString::to_string)
        ));
    }
    let Some(roots) = value.get("roots").and_then(serde_json::Value::as_array) else {
        return RunnerRoots::Unusable(format!("{} has no roots list", path.display()));
    };
    let mut out = Vec::new();
    let mut skipped = 0usize;
    for root in roots {
        let folder = root
            .get("path")
            .and_then(serde_json::Value::as_str)
            .map(PathBuf::from)
            .filter(|folder| folder.is_absolute());
        let Some(folder) = folder else {
            skipped += 1;
            continue;
        };
        let helpers = root
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|entry| {
                entry
                    .get("owner_principal")
                    .and_then(serde_json::Value::as_str)
                    == Some(RUNNER_HELPER_OWNER)
            })
            .filter_map(|entry| entry.get("session").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect();
        out.push(RunnerRoot {
            store: folder.join("opencode.db"),
            helpers: Arc::new(helpers),
        });
    }
    if skipped > 0 {
        log_once(format!(
            "Magic Context dashboard: skipped {skipped} root(s) without an absolute path in {}",
            path.display()
        ));
    }
    RunnerRoots::Roots(out)
}

/// The configured store paths exactly as written in the user config, in
/// order. Entries that are not strings are dropped; the plugin's schema
/// refuses them anyway.
pub(crate) fn configured_store_values(user_config: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(user_config) else {
        return Vec::new();
    };
    serde_json::from_str::<serde_json::Value>(&crate::jsonc::strip_jsonc(&text))
        .ok()
        .and_then(|value| {
            value
                .pointer("/dashboard/opencode_db_paths")
                .and_then(serde_json::Value::as_array)
                .cloned()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| entry.as_str().map(str::to_string))
        .collect()
}

/// The `opencode.db` file one configured value names, or why it is refused.
/// Values must be absolute paths without `{env:}`/`{file:}` tokens: the
/// dashboard reads the file as written and does not expand them.
pub(crate) fn configured_store_path(raw: &str) -> Result<PathBuf, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("Empty path.".to_string());
    }
    if value.contains("{env:") || value.contains("{file:") {
        return Err(
            "{env:} and {file:} tokens are not expanded here; write the absolute path.".to_string(),
        );
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(
            "Not an absolute path; write the full path to opencode.db or to its folder."
                .to_string(),
        );
    }
    Ok(if path.is_dir() {
        path.join("opencode.db")
    } else {
        path
    })
}

struct Candidate {
    path: PathBuf,
    origin: StoreOrigin,
    configured_value: Option<String>,
    refused: Option<String>,
    helpers: Arc<HashSet<String>>,
}

#[derive(Debug, PartialEq, Eq, Hash)]
enum StoreKey {
    Identity(u64, u64),
    Path(PathBuf),
}

fn store_key(path: &Path, metadata: &std::fs::Metadata) -> StoreKey {
    match file_identity(metadata) {
        Some((device, inode)) => StoreKey::Identity(device, inode),
        None => StoreKey::Path(std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())),
    }
}

/// The store list for explicit sources, without process environment or
/// caches: the rows the Config screen shows and the stores readers open.
pub(crate) fn store_list_for(
    data_home: &Path,
    overrides: &OpenCodeDbOverrides,
    runner_roots: &RunnerRoots,
    configured: &[String],
) -> (Vec<OpenCodeStoreRow>, Vec<ReadableStore>) {
    let mut candidates = Vec::new();
    let default = resolve_opencode_db_for(data_home, overrides);
    candidates.push(Candidate {
        refused: (default.path == Path::new(":memory:"))
            .then(|| "An in-memory store holds no sessions to read.".to_string()),
        path: default.path,
        origin: StoreOrigin::Default,
        configured_value: None,
        helpers: Arc::default(),
    });
    if let RunnerRoots::Roots(roots) = runner_roots {
        for root in roots {
            candidates.push(Candidate {
                path: root.store.clone(),
                origin: StoreOrigin::Runner,
                configured_value: None,
                refused: None,
                helpers: root.helpers.clone(),
            });
        }
    }
    for raw in configured {
        let (path, refused) = match configured_store_path(raw) {
            Ok(path) => (path, None),
            Err(reason) => (PathBuf::from(raw.trim()), Some(reason)),
        };
        candidates.push(Candidate {
            path,
            origin: StoreOrigin::Configured,
            configured_value: Some(raw.clone()),
            refused,
            helpers: Arc::default(),
        });
    }

    let mut rows = Vec::with_capacity(candidates.len());
    let mut readable = Vec::new();
    let mut seen: Vec<(StoreKey, StoreOrigin)> = Vec::new();
    for candidate in candidates {
        let metadata = std::fs::metadata(&candidate.path)
            .ok()
            .filter(std::fs::Metadata::is_file);
        let found = metadata.is_some();
        let note = if let Some(reason) = candidate.refused {
            Some(reason)
        } else if let Some(metadata) = metadata {
            let key = store_key(&candidate.path, &metadata);
            if let Some((_, first)) = seen.iter().find(|(seen_key, _)| *seen_key == key) {
                Some(format!(
                    "Same file as the {} store listed above; read once.",
                    origin_label(*first)
                ))
            } else {
                seen.push((key, candidate.origin));
                wal_refusal(&candidate.path)
            }
        } else {
            Some("Not found.".to_string())
        };
        let read = note.is_none();
        if read {
            readable.push(ReadableStore {
                path: candidate.path.clone(),
                origin: candidate.origin,
                helpers: candidate.helpers,
            });
        }
        rows.push(OpenCodeStoreRow {
            path: candidate.path.to_string_lossy().to_string(),
            origin: candidate.origin,
            found,
            read,
            note,
            configured_value: candidate.configured_value,
        });
    }
    (rows, readable)
}

fn origin_label(origin: StoreOrigin) -> &'static str {
    match origin {
        StoreOrigin::Default => "default",
        StoreOrigin::Runner => "CortexKit runner",
        StoreOrigin::Configured => "configured",
    }
}

// ── The list for this process ─────────────────────────────────────────────

/// What a file looked like: enough to tell that it was rewritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileStamp {
    len: u64,
    modified_ns: Option<u128>,
    identity: Option<(u64, u64)>,
}

pub(crate) fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        len: metadata.len(),
        modified_ns: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos()),
        identity: file_identity(&metadata),
    })
}

type ParseCache<T> = Mutex<Option<(PathBuf, Option<FileStamp>, T)>>;

/// Parses `path` again only when the file changed since the last parse. The
/// store list is resolved on every poll, and both source files rarely change.
fn cached_parse<T: Clone>(
    cache: &'static OnceLock<ParseCache<T>>,
    path: &Path,
    parse: impl FnOnce(&Path) -> T,
) -> T {
    let stamp = file_stamp(path);
    let cache = cache.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|poison| poison.into_inner());
    if let Some((cached_path, cached_stamp, value)) = guard.as_ref() {
        if cached_path == path && *cached_stamp == stamp {
            return value.clone();
        }
    }
    let value = parse(path);
    *guard = Some((path.to_path_buf(), stamp, value.clone()));
    value
}

/// Test builds never fall back to the real home folder for these sources: a
/// test that sets no `XDG_*` folder must not read the user's own files.
///
/// This covers only the crate's own unit tests: `cfg!(test)` is false when
/// an integration test under `tests/` links the library, which is built as
/// for normal use there. Those tests get the same protection from
/// `tests/support/isolated_home.rs`, which every one of them calls first and
/// which points every folder variable at a throwaway home. It does not cover
/// the default store's own resolution (`OPENCODE_DB`, `XDG_DATA_HOME`, else
/// the home folder), which has never been guarded here.
fn source_root(variable: &str) -> bool {
    !cfg!(test) || std::env::var_os(variable).is_some()
}

fn current_store_list() -> (Vec<OpenCodeStoreRow>, Vec<ReadableStore>) {
    static RUNNER_ROOTS: OnceLock<ParseCache<RunnerRoots>> = OnceLock::new();
    static CONFIGURED: OnceLock<ParseCache<Vec<String>>> = OnceLock::new();
    let data_home = super::data_home();
    let overrides = super::opencode_overrides();
    let roots = if source_root("XDG_DATA_HOME") {
        cached_parse(
            &RUNNER_ROOTS,
            &runner_roots_path(&data_home),
            parse_runner_roots,
        )
    } else {
        RunnerRoots::Absent
    };
    if let RunnerRoots::Unusable(reason) = &roots {
        log_once(format!(
            "Magic Context dashboard: reading no CortexKit runner stores: {reason}"
        ));
    }
    let configured = if source_root("XDG_CONFIG_HOME") {
        let user_config = crate::config::resolve_user_config_path(&crate::config::config_home());
        cached_parse(&CONFIGURED, &user_config, configured_store_values)
    } else {
        Vec::new()
    };
    store_list_for(&data_home, &overrides, &roots, &configured)
}

/// Every listed store with where it came from and whether it is read.
pub fn opencode_store_rows() -> Vec<OpenCodeStoreRow> {
    current_store_list().0
}

/// The stores readers open, in list order.
pub(crate) fn readable_opencode_stores() -> Vec<ReadableStore> {
    current_store_list().1
}

/// Logs `message` the first time this process sees it. The store list is
/// resolved on every poll; a problem that persists is logged once.
fn log_once(message: String) {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let mut logged = LOGGED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if logged.len() < 256 && logged.insert(message.clone()) {
        eprintln!("{message}");
    }
}

// ── Opening one store ─────────────────────────────────────────────────────

/// Which of SQLite's WAL side files exist next to a store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WalFiles {
    Both,
    Neither,
    OnlyWal,
    OnlyShm,
}

fn side_file(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

pub(crate) fn wal_files(path: &Path) -> WalFiles {
    match (
        side_file(path, "-wal").exists(),
        side_file(path, "-shm").exists(),
    ) {
        (true, true) => WalFiles::Both,
        (false, false) => WalFiles::Neither,
        (true, false) => WalFiles::OnlyWal,
        (false, true) => WalFiles::OnlyShm,
    }
}

/// Why a store with exactly one WAL side file is skipped; `None` otherwise.
fn wal_refusal(path: &Path) -> Option<String> {
    let (present, missing) = match wal_files(path) {
        WalFiles::Both | WalFiles::Neither => return None,
        WalFiles::OnlyWal => ("-wal", "-shm"),
        WalFiles::OnlyShm => ("-shm", "-wal"),
    };
    let reason = format!(
        "Skipped: {present} exists without {missing}, so the store is mid-shutdown or damaged. Opening it now could change what its owner left behind; it is read again once both or neither exist."
    );
    log_once(format!(
        "Magic Context dashboard: skipping {}: {reason}",
        path.display()
    ));
    Some(reason)
}

#[derive(Debug)]
pub(crate) enum StoreOpenError {
    /// The store must not be read now; the text says why.
    Refused(String),
    Sqlite(rusqlite::Error),
}

impl From<rusqlite::Error> for StoreOpenError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<StoreOpenError> for rusqlite::Error {
    fn from(error: StoreOpenError) -> Self {
        match error {
            StoreOpenError::Sqlite(error) => error,
            StoreOpenError::Refused(reason) => rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some(reason),
            ),
        }
    }
}

/// A read-only connection to one store, opened by the rules above.
pub(crate) struct StoreConnection {
    pub conn: Connection,
    path: PathBuf,
    /// Set when the store was opened `immutable=1`: the file as it was then.
    immutable_stamp: Option<FileStamp>,
}

/// A `file:` URI for `path`, for SQLite's `immutable` parameter. Every byte
/// outside a small safe set is percent-encoded, so `?`, `#`, `%` and spaces
/// in a folder name stay part of the path. Windows drive paths become
/// `file:/C:/...` and UNC paths `file:////server/share/...`, the forms
/// SQLite's URI parser maps back to the native path.
pub(crate) fn sqlite_file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let mut uri = String::from("file:");
    if text.starts_with("//") {
        uri.push_str("//");
    } else if !text.starts_with('/') {
        uri.push('/');
    }
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "busy_timeout", 5000)?;
    // A read-only connection cannot checkpoint, but say so explicitly: the
    // last connection to close otherwise tries to checkpoint the owner's WAL.
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    Ok(())
}

pub(crate) fn open_store(path: &Path) -> Result<StoreConnection, StoreOpenError> {
    match wal_files(path) {
        WalFiles::Both => {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            configure(&conn)?;
            Ok(StoreConnection {
                conn,
                path: path.to_path_buf(),
                immutable_stamp: None,
            })
        }
        WalFiles::Neither => {
            let stamp = file_stamp(path)
                .ok_or_else(|| StoreOpenError::Refused("Not found.".to_string()))?;
            let conn = Connection::open_with_flags(
                format!("{}?mode=ro&immutable=1", sqlite_file_uri(path)),
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_URI
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            configure(&conn)?;
            Ok(StoreConnection {
                conn,
                path: path.to_path_buf(),
                immutable_stamp: Some(stamp),
            })
        }
        WalFiles::OnlyWal | WalFiles::OnlyShm => Err(StoreOpenError::Refused(
            wal_refusal(path).unwrap_or_default(),
        )),
    }
}

impl StoreConnection {
    /// True when what was read through this connection can be trusted. A
    /// normally opened store always can; an immutable one only while its file
    /// is unchanged and the owner has not started (no WAL files appeared).
    pub(crate) fn unchanged(&self) -> bool {
        match self.immutable_stamp {
            None => true,
            Some(stamp) => {
                file_stamp(&self.path) == Some(stamp) && wal_files(&self.path) == WalFiles::Neither
            }
        }
    }

    /// True when a fresh open would choose the same mode as this connection.
    pub(crate) fn mode_current(&self) -> bool {
        match self.immutable_stamp {
            None => wal_files(&self.path) == WalFiles::Both,
            Some(_) => self.unchanged(),
        }
    }

    /// Ends anything a reader left open on this connection: a statement
    /// stepped but not finished, or a transaction never committed. Either
    /// holds a read snapshot that stops the owner's checkpoint. Returns how
    /// many it ended; readers are expected to leave none.
    pub(crate) fn release_open_reads(&self) -> usize {
        release_open_reads(&self.conn)
    }
}

/// See `StoreConnection::release_open_reads`.
pub(crate) fn release_open_reads(conn: &Connection) -> usize {
    let mut released = 0;
    // SAFETY: the handle belongs to `conn`, which outlives this loop, and no
    // other thread uses the connection while we hold `&Connection` here (the
    // dashboard opens stores with SQLITE_OPEN_NO_MUTEX and never shares one
    // across threads). `sqlite3_reset` leaves each statement valid for
    // rusqlite, which resets statements before reuse anyway.
    unsafe {
        let db = conn.handle();
        let mut statement = rusqlite::ffi::sqlite3_next_stmt(db, std::ptr::null_mut());
        while !statement.is_null() {
            if rusqlite::ffi::sqlite3_stmt_busy(statement) != 0 {
                rusqlite::ffi::sqlite3_reset(statement);
                released += 1;
            }
            statement = rusqlite::ffi::sqlite3_next_stmt(db, statement);
        }
    }
    if !conn.is_autocommit() && conn.execute_batch("ROLLBACK").is_ok() {
        released += 1;
    }
    released
}

/// Opens `path` by the rules above, runs `read`, and returns its result only
/// when the read can be trusted. An immutable store that changed during the
/// read (its owner started, say) is read once more, possibly in WAL mode
/// now; a second change gives up for this call.
pub(crate) fn read_store<T>(
    path: &Path,
    mut read: impl FnMut(&Connection) -> T,
) -> Result<T, StoreOpenError> {
    for _ in 0..2 {
        let store = open_store(path)?;
        let value = read(&store.conn);
        store.release_open_reads();
        if store.unchanged() {
            return Ok(value);
        }
    }
    Err(StoreOpenError::Refused(
        "The store changed while it was being read.".to_string(),
    ))
}
