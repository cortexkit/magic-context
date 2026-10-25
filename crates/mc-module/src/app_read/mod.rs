//! A session-independent, read-only lane for the operator's apps.

pub mod admission;
mod agent_ids;
mod cache_why;
mod compartment;
mod config;
mod context_states;
mod dreamer;
pub mod envelope;
mod health;
mod locator;
mod part_ref;
#[cfg(test)]
mod part_ref_tests;
mod project_memory;
#[cfg(test)]
mod samples_tests;
mod search;
mod session_data;
mod version;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use serde_json::{json, Map, Value};
use sha2::Digest;
use subc_client_rs::HandlerOutcome;

pub const SERVICE_ID: &str = "mc-app-read";
pub const APP_READ_METHODS: &[&str] = &[
    "context.states",
    "context.compartment",
    "context.search",
    "context.cache_why",
    "session_data.read",
    "project_memory.read",
    "dreamer.read",
    "store.health",
    "config.read",
    "config.embedding_probe",
];

const READ_BUDGET: Duration = Duration::from_millis(250);
const CURSOR_LIMIT: usize = 512;
pub(super) const RANKED_TTL_MS: i64 = 120_000;

/// Read access for one app call. It holds the store the module is already serving,
/// the config cache, and the project roots bound on other routes. It has no write
/// method and no path back into transform or session state.
pub struct AppReadContext<'a> {
    store: Option<Arc<mc_store::McStore>>,
    config: Arc<Mutex<crate::config::ConfigCache>>,
    bound_roots: Vec<PathBuf>,
    identity_roots: HashMap<String, PathBuf>,
    resolved_roots: Arc<std::sync::OnceLock<HashMap<String, PathBuf>>>,
    project_paths: Arc<std::sync::OnceLock<Vec<(String, u8)>>>,
    now_ms: i64,
    budget: Duration,
    row_budget: usize,
    sql_log: Option<Arc<Mutex<Vec<String>>>>,
    probe: Option<Arc<dyn config::ProbeTransport>>,
    config_files: Option<(PathBuf, Option<PathBuf>)>,
    connections: Option<(&'a rusqlite::Connection, &'a rusqlite::Connection)>,
}

impl AppReadContext<'_> {
    /// Capture the serving store, config cache and bound-root snapshot for one request.
    pub fn from_parts(
        store: Option<Arc<mc_store::McStore>>,
        config: Arc<Mutex<crate::config::ConfigCache>>,
        bound_roots: Vec<PathBuf>,
        now_ms: i64,
    ) -> Self {
        Self {
            store,
            config,
            bound_roots,
            identity_roots: HashMap::new(),
            resolved_roots: Arc::new(std::sync::OnceLock::new()),
            project_paths: Arc::new(std::sync::OnceLock::new()),
            now_ms,
            budget: READ_BUDGET,
            row_budget: envelope::ROW_BUDGET,
            sql_log: None,
            probe: None,
            config_files: None,
            connections: None,
        }
    }

    #[cfg(test)]
    fn for_test(store: Arc<mc_store::McStore>, now_ms: i64) -> Self {
        Self::from_parts(
            Some(store),
            Arc::new(Mutex::new(crate::config::ConfigCache::default())),
            Vec::new(),
            now_ms,
        )
    }

    /// Return the caller-independent timestamp captured for the reply envelope.
    pub fn now_ms(&self) -> i64 {
        self.now_ms
    }

    /// Return the escaped-JSON budget available to a list's rows.
    pub fn row_budget(&self) -> usize {
        self.row_budget
    }

    #[cfg(test)]
    fn set_row_budget(&mut self, budget: usize) {
        self.row_budget = budget;
    }

    #[cfg(test)]
    fn set_budget(&mut self, budget: Duration) {
        self.budget = budget;
    }

    #[cfg(test)]
    fn set_sql_log(&mut self, log: Arc<Mutex<Vec<String>>>) {
        self.sql_log = Some(log);
    }

    #[cfg(test)]
    pub fn set_identity_root(&mut self, identity: impl Into<String>, root: PathBuf) {
        self.identity_roots.insert(identity.into(), root);
    }

    #[cfg(test)]
    pub fn set_probe(&mut self, probe: Arc<dyn config::ProbeTransport>) {
        self.probe = Some(probe);
    }

    #[cfg(test)]
    pub fn set_config_files(&mut self, user: PathBuf, project: Option<PathBuf>) {
        self.config_files = Some((user, project));
    }

    /// Observe SQL selected by an operation when a test has installed a query log.
    pub fn note_sql(&self, sql: &str) {
        if let Some(log) = &self.sql_log {
            log.lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(sql.to_string());
        }
    }

    /// Check elapsed non-SQL work against the same duration as the SQLite deadline.
    pub fn expired(&self, started: Instant) -> bool {
        started.elapsed() >= self.budget
    }

    /// Return the time still available for non-interruptible work in this read.
    pub fn remaining(&self, started: Instant) -> Duration {
        self.budget.saturating_sub(started.elapsed())
    }

    /// Borrow the serving context database through its query-only reader.
    pub fn with_context_read<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, HandlerOutcome> {
        if let Some((context, _)) = self.connections {
            return read(context).map_err(map_sql);
        }
        let store = self.store.as_ref().ok_or_else(store_unavailable)?;
        store
            .with_context_read(|conn| {
                let _deadline = ReadDeadline::install(conn, self.budget);
                read(conn)
            })
            .map_err(map_store)
    }

    /// Borrow the serving module database through its read-only reader.
    pub fn with_store_read<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, HandlerOutcome> {
        if let Some((_, store)) = self.connections {
            return read(store).map_err(map_sql);
        }
        let store = self.store.as_ref().ok_or_else(store_unavailable)?;
        store
            .with_store_read(|conn| {
                let _deadline = ReadDeadline::install(conn, self.budget);
                read(conn)
            })
            .map_err(map_store)
    }

    /// Borrow both serving databases for an operation that needs two read connections.
    pub fn with_reads<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection, &rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, HandlerOutcome> {
        if let Some((context, store)) = self.connections {
            return read(context, store).map_err(map_sql);
        }
        self.with_context_read(|context| {
            let store = self.store.as_ref().expect("context read requires a store");
            store
                .with_store_read(|store| {
                    let _deadline = ReadDeadline::install(store, self.budget);
                    read(context, store)
                })
                .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
        })
    }

    /// Reuse one pair of read transactions throughout a dispatched operation.
    fn borrowed<'a>(
        &self,
        context: &'a rusqlite::Connection,
        store: &'a rusqlite::Connection,
    ) -> AppReadContext<'a> {
        AppReadContext {
            store: self.store.clone(),
            config: Arc::clone(&self.config),
            bound_roots: self.bound_roots.clone(),
            identity_roots: self.identity_roots.clone(),
            resolved_roots: Arc::clone(&self.resolved_roots),
            project_paths: Arc::clone(&self.project_paths),
            now_ms: self.now_ms,
            budget: self.budget,
            row_budget: self.row_budget,
            sql_log: self.sql_log.clone(),
            probe: self.probe.clone(),
            config_files: self.config_files.clone(),
            connections: Some((context, store)),
        }
    }

    /// Run a context-only read without exposing the store itself to an operation.
    pub fn context<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, HandlerOutcome> {
        self.with_context_read(read)
    }

    /// Run a module-store-only read without exposing the store itself to an operation.
    pub fn store_db<T>(
        &self,
        read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
    ) -> Result<T, HandlerOutcome> {
        self.with_store_read(read)
    }

    /// Borrow the config cache used by the serving handler's runtime policy.
    pub fn config_cache(&self) -> Arc<Mutex<crate::config::ConfigCache>> {
        Arc::clone(&self.config)
    }

    /// Return only the project roots visible in this request's bind snapshot.
    pub fn bound_roots(&self) -> &[PathBuf] {
        &self.bound_roots
    }

    /// Resolve identities from the captured roots once, without accepting caller-supplied paths.
    pub fn identity_root(&self, identity: &str) -> Option<&Path> {
        self.identity_roots
            .get(identity)
            .or_else(|| {
                self.resolved_roots
                    .get_or_init(|| {
                        let resolver = crate::project_identity::ProjectIdentityResolver::new();
                        self.bound_roots()
                            .iter()
                            .filter_map(|root| {
                                resolver
                                    .resolve(root)
                                    .ok()
                                    .map(|identity| (identity, root.clone()))
                            })
                            .collect()
                    })
                    .get(identity)
            })
            .map(PathBuf::as_path)
    }

    /// Load the serving store's project-path catalog at most once in this request.
    pub(super) fn cached_project_paths(
        &self,
        load: impl FnOnce() -> Result<Vec<(String, u8)>, HandlerOutcome>,
    ) -> Result<&[(String, u8)], HandlerOutcome> {
        if self.project_paths.get().is_none() {
            let paths = load()?;
            let _ = self.project_paths.set(paths);
        }
        Ok(self.project_paths.get().expect("loaded project catalog"))
    }

    /// Return an injected HTTP transport for fixture-only embedding probes.
    pub fn probe(&self) -> Option<&Arc<dyn config::ProbeTransport>> {
        self.probe.as_ref()
    }

    /// Return explicit fixture config paths when a test has supplied them.
    pub fn config_files(&self) -> Option<(&Path, Option<&Path>)> {
        self.config_files
            .as_ref()
            .map(|(user, project)| (user.as_path(), project.as_deref()))
    }
}

/// Clear a borrowed connection's progress handler on every return path, including unwinding.
struct ReadDeadline<'a>(&'a rusqlite::Connection);

impl<'a> ReadDeadline<'a> {
    fn install(conn: &'a rusqlite::Connection, budget: Duration) -> Self {
        let started = Instant::now();
        conn.progress_handler(1000, Some(move || started.elapsed() >= budget));
        Self(conn)
    }
}

impl Drop for ReadDeadline<'_> {
    fn drop(&mut self) {
        self.0.progress_handler(0, None::<fn() -> bool>);
    }
}

/// Translate a SQLite interruption into the public budget refusal without leaking SQL errors.
fn map_sql(error: rusqlite::Error) -> HandlerOutcome {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
        return named(
            "read_budget_exceeded",
            "The app read exceeded its time budget.",
        );
    }
    store_unavailable()
}

fn store_unavailable() -> HandlerOutcome {
    named("store_unavailable", "The Magic Context store is not open.")
}

fn map_store(error: mc_store::McStoreError) -> HandlerOutcome {
    let message = error.to_string();
    if message.to_ascii_lowercase().contains("interrupted") {
        return named(
            "read_budget_exceeded",
            "The app read exceeded its time budget.",
        );
    }
    if message.contains("single_store_migration_required")
        || message.contains("single-store migration")
        || message.contains("SingleStoreMigrationRequired")
    {
        return named(
            "single_store_migration_required",
            "The single-store migration has not finished.",
        );
    }
    named(
        "store_unavailable",
        "The Magic Context store could not be read.",
    )
}

/// Build a named refusal without parameter details.
pub(super) fn named(code: &str, message: impl Into<String>) -> HandlerOutcome {
    HandlerOutcome::Error {
        code: code.into(),
        message: message.into(),
    }
}

/// Build a named refusal with machine-readable details.
pub(super) fn named_detail(
    code: &str,
    message: impl Into<String>,
    detail: Value,
) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: code.into(),
        message: message.into(),
        detail,
    }
}

/// Refuse a parameter by its dotted field name and validation reason.
pub(super) fn invalid(field: &str, reason: &str) -> HandlerOutcome {
    envelope::invalid_field(field, reason, None)
}

/// Refuse an indexed read until its required index is installed.
pub(super) fn index_unavailable(section: &str, index: &str) -> HandlerOutcome {
    named_detail(
        "app_op_unavailable",
        format!("Section {section} needs index {index}, which is not installed."),
        json!({"section": section, "index": index}),
    )
}

/// Validate an object's keys with the shared dotted-path allowlist.
pub(super) fn allow(
    object: &Map<String, Value>,
    keys: &[&str],
    path: &str,
) -> Result<(), HandlerOutcome> {
    envelope::refuse_unknown(object, keys, path)
}

/// Decode an optional string and report type errors at its dotted path.
pub(super) fn opt_str(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<Option<String>, HandlerOutcome> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(&format!("{path}.{key}"), "type")),
    }
}

/// Decode an optional integer, accepting decimal strings for stored identifiers.
pub(super) fn opt_i64(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<Option<i64>, HandlerOutcome> {
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid(&format!("{path}.{key}"), "type")),
        Some(Value::String(value)) => value
            .parse::<i64>()
            .map(Some)
            .map_err(|_| invalid(&format!("{path}.{key}"), "type")),
        Some(_) => Err(invalid(&format!("{path}.{key}"), "type")),
    }
}

/// Decode a filter array containing only nonempty, NUL-free strings.
pub(super) fn string_array(value: &Value, path: &str) -> Result<Vec<String>, HandlerOutcome> {
    let Some(items) = value.as_array() else {
        return Err(invalid(path, "type"));
    };
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|text| !text.is_empty() && !text.contains('\0'))
                .map(str::to_string)
                .ok_or_else(|| invalid(path, "type"))
        })
        .collect()
}

#[derive(Clone, Debug)]
/// The three-part session identity supplied by an app, not an authorization claim.
pub(super) struct SessionRef {
    pub runner: String,
    pub harness: String,
    pub session: String,
}

/// Validate every field in an app-supplied session identity.
pub(super) fn session_ref(value: &Value, path: &str) -> Result<SessionRef, HandlerOutcome> {
    let object = envelope::object(value, path)?;
    allow(object, &["runner", "harness", "session"], path)?;
    Ok(SessionRef {
        runner: bounded(object, "runner", path, 256)?,
        harness: bounded(object, "harness", path, 256)?,
        session: bounded(object, "session", path, 256)?,
    })
}

fn bounded(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
    max: usize,
) -> Result<String, HandlerOutcome> {
    let field = format!("{path}.{key}");
    let Some(value) = object.get(key).and_then(Value::as_str) else {
        return Err(invalid(&field, "type"));
    };
    let bytes = value.len();
    if bytes == 0 || bytes > max || value.contains('\0') {
        return Err(envelope::invalid_field(&field, "range", Some(max)));
    }
    Ok(value.to_string())
}

/// Decode a bounded positive row limit with an operation-specific default.
pub(super) fn page_limit(
    object: &Map<String, Value>,
    default: usize,
    max: usize,
    field: &str,
) -> Result<usize, HandlerOutcome> {
    match object.get("limit") {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Number(value)) => {
            let Some(limit) = value.as_u64() else {
                return Err(invalid(field, "type"));
            };
            let limit = usize::try_from(limit).unwrap_or(usize::MAX);
            if limit == 0 || limit > max {
                Err(envelope::invalid_field(field, "range", Some(max)))
            } else {
                Ok(limit)
            }
        }
        Some(_) => Err(invalid(field, "type")),
    }
}

/// Truncate text at a UTF-8 boundary and retain its original byte length.
pub(super) fn cut_text(text: &str, max_bytes: usize) -> (String, bool, usize) {
    let bytes = text.len();
    if bytes <= max_bytes {
        return (text.to_string(), false, bytes);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true, bytes)
}

/// Cap a free-form row field with size markers, using null rather than invalid partial structured text.
pub(super) fn cap_field(row: &mut Value, field: &str, max_bytes: usize, structured: bool) {
    let Some(text) = row.get(field).and_then(Value::as_str) else {
        return;
    };
    let (text, truncated, bytes) = cut_text(text, max_bytes);
    if truncated {
        row[field] = if structured { Value::Null } else { json!(text) };
        row[format!("{field}_truncated")] = json!(true);
        row[format!("{field}_bytes")] = json!(bytes);
    }
}

#[derive(Clone, Debug)]
/// Decoded keyset or offset position, with an optional ranked-query issue time.
pub(super) struct Cursor {
    pub keys: Vec<String>,
    /// Issue time for a ranked-search cursor. Expiry is decided while decoding.
    #[allow(dead_code)]
    pub issued_at_ms: Option<i64>,
}

/// Bind a cursor to the normalized scope and filters of one read.
pub(super) fn digest_of(parts: &[(&str, &Value)]) -> String {
    let mut object = Map::new();
    for (key, value) in parts {
        object.insert((*key).to_string(), (*value).clone());
    }
    let bytes = serde_json::to_vec(&object).unwrap_or_default();
    format!("{:x}", sha2::Sha256::digest(&bytes))
}

/// Encode a bounded opaque cursor tied to its operation, section and filters.
pub(super) fn encode_cursor(
    op: &str,
    section: &str,
    digest: &str,
    keys: &[String],
    issued_at_ms: Option<i64>,
) -> Result<String, HandlerOutcome> {
    let raw = serde_json::to_vec(&json!({
        "op": op,
        "section": section,
        "digest": digest,
        "keys": keys,
        "issued_at_ms": issued_at_ms,
    }))
    .expect("cursor json");
    let cursor = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, raw);
    if cursor.len() > CURSOR_LIMIT {
        return Err(named("cursor_invalid", "The page cursor is not valid."));
    }
    Ok(cursor)
}

/// Check cursor ownership and ranked-query expiry before decoding its position.
pub(super) fn decode_cursor(
    raw: Option<&str>,
    op: &str,
    section: &str,
    digest: &str,
    now_ms: i64,
    ttl_ms: Option<i64>,
) -> Result<Option<Cursor>, HandlerOutcome> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.is_empty() || raw.len() > CURSOR_LIMIT {
        return Err(named("cursor_invalid", "The page cursor is not valid."));
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, raw)
        .map_err(|_| named("cursor_invalid", "The page cursor is not valid."))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| named("cursor_invalid", "The page cursor is not valid."))?;
    if value.get("op").and_then(Value::as_str) != Some(op)
        || value.get("section").and_then(Value::as_str) != Some(section)
        || value.get("digest").and_then(Value::as_str) != Some(digest)
    {
        return Err(named(
            "cursor_mismatch",
            "The page cursor belongs to a different read.",
        ));
    }
    let issued_at_ms = value.get("issued_at_ms").and_then(Value::as_i64);
    if let Some(ttl) = ttl_ms {
        let Some(issued) = issued_at_ms else {
            return Err(named("cursor_invalid", "The page cursor is not valid."));
        };
        if now_ms.saturating_sub(issued) > ttl {
            return Err(named_detail(
                "cursor_expired",
                "The ranked search cursor has expired.",
                json!({"retry_after_ms": 0}),
            ));
        }
    }
    let keys = value
        .get("keys")
        .and_then(Value::as_array)
        .ok_or_else(|| named("cursor_invalid", "The page cursor is not valid."))?
        .iter()
        .map(|key| {
            key.as_str()
                .map(str::to_string)
                .ok_or_else(|| named("cursor_invalid", "The page cursor is not valid."))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(Cursor { keys, issued_at_ms }))
}

/// Accumulate rows against their escaped JSON byte budget.
pub(super) struct Page {
    rows: Vec<Value>,
    bytes: usize,
    budget: usize,
}

impl Page {
    /// Start an empty JSON array with room for its delimiters.
    pub(super) fn new(budget: usize) -> Self {
        Self {
            rows: Vec::new(),
            bytes: 2,
            budget,
        }
    }

    /// Report how many complete rows have been accepted.
    pub(super) fn len(&self) -> usize {
        self.rows.len()
    }

    /// Consume the accumulator into its accepted rows.
    pub(super) fn rows(self) -> Vec<Value> {
        self.rows
    }

    /// Keep at least one matching row. Later rows stop before the byte budget.
    pub(super) fn try_push(&mut self, row: Value) -> bool {
        let encoded = serde_json::to_vec(&row).unwrap_or_default();
        let next = self.bytes.saturating_add(encoded.len()).saturating_add(1);
        if !self.rows.is_empty() && next > self.budget {
            return false;
        }
        self.bytes = next;
        self.rows.push(row);
        true
    }
}

/// Serialize a list section with its paging and version metadata.
pub(super) fn list_reply(
    op: &str,
    section: &str,
    as_of_ms: i64,
    version: Option<String>,
    complete: bool,
    rows: Vec<Value>,
    next_cursor: Option<String>,
) -> HandlerOutcome {
    let mut fields = Map::new();
    fields.insert("section".into(), json!(section));
    fields.insert(
        "version".into(),
        version.map(Value::String).unwrap_or(Value::Null),
    );
    fields.insert("complete".into(), json!(complete));
    fields.insert("rows".into(), json!(rows));
    fields.insert(
        "next_cursor".into(),
        next_cursor.map(Value::String).unwrap_or(Value::Null),
    );
    envelope::reply(op, as_of_ms, fields)
}

/// Serialize a single-object section or operation with optional version metadata.
pub(super) fn row_reply(
    op: &str,
    section: Option<&str>,
    as_of_ms: i64,
    version: Option<String>,
    row: Value,
) -> HandlerOutcome {
    let mut fields = Map::new();
    if let Some(section) = section {
        fields.insert("section".into(), json!(section));
        fields.insert(
            "version".into(),
            version.map(Value::String).unwrap_or(Value::Null),
        );
    }
    fields.insert("row".into(), row);
    envelope::reply(op, as_of_ms, fields)
}

/// Prepare a statement on an already-admitted read connection.
pub(super) fn prepare<'a>(
    conn: &'a rusqlite::Connection,
    sql: &str,
) -> rusqlite::Result<rusqlite::Statement<'a>> {
    conn.prepare(sql)
}

/// Preserve accumulated list rows when SQLite interrupts the next step for its deadline.
pub(super) fn next_row<'a, 'stmt>(
    rows: &'a mut rusqlite::Rows<'stmt>,
    interrupted: &mut bool,
) -> rusqlite::Result<Option<&'a rusqlite::Row<'stmt>>> {
    match rows.next() {
        Err(error)
            if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) =>
        {
            *interrupted = true;
            Ok(None)
        }
        result => result,
    }
}

/// Check the persisted single-store migration gate without changing it.
pub(super) fn migrated(conn: &rusqlite::Connection) -> rusqlite::Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'single_store_state')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    let state: Option<String> = conn
        .query_row(
            "SELECT state FROM single_store_state WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(state.as_deref() == Some("migrated"))
}

pub fn handle(
    caller: &admission::AppCaller,
    allow_direct: bool,
    body: &[u8],
    ctx: &AppReadContext,
) -> HandlerOutcome {
    if let Err(refusal) = caller.recheck(allow_direct) {
        return refusal;
    }
    let request = match envelope::parse(body) {
        Ok(request) => request,
        Err(refusal) => return refusal,
    };
    match request.method.as_str() {
        "session_data.read" | "project_memory.read" | "dreamer.read" | "store.health" => {
            match ctx.with_reads(|context, store| {
                let ctx = ctx.borrowed(context, store);
                Ok(match request.method.as_str() {
                    "session_data.read" => session_data::read(caller, &ctx, &request.params),
                    "project_memory.read" => project_memory::read(caller, &ctx, &request.params),
                    "dreamer.read" => dreamer::read(caller, &ctx, &request.params),
                    "store.health" => health::read(caller, &ctx, &request.params),
                    _ => unreachable!(),
                })
            }) {
                Ok(outcome) => outcome,
                Err(refusal) => refusal,
            }
        }
        "config.read" => config::read(caller, ctx, &request.params),
        "config.embedding_probe" => config::probe(caller, ctx, &request.params),
        other => envelope::unknown_method(other),
    }
}

#[cfg(test)]
pub(super) mod tests_support {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    pub fn caller() -> admission::AppCaller {
        admission::admit(
            &admission::tests::phone_bind(),
            crate::DEFAULT_MODULE_ID,
            true,
        )
        .expect("phone bind")
    }

    pub fn open_store(dir: &Path) -> Arc<mc_store::McStore> {
        Arc::new(
            mc_store::McStore::open_for_test(&crate::test_support::descriptor(dir))
                .expect("throwaway store"),
        )
    }

    pub fn apply_sql(db: &Path, sql: &str) {
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/app-read-g/apply_sql.py");
        let mut child = std::process::Command::new("python3")
            .arg(&script)
            .arg(db)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("python3");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(sql.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "fixture sql failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    pub fn explain(db: &Path, sql: &str) -> String {
        let conn = rusqlite::Connection::open(db).unwrap();
        let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let nulls = vec![rusqlite::types::Value::Text(String::new()); statement.parameter_count()];
        let params: Vec<&dyn rusqlite::ToSql> = nulls.iter().map(|value| value as _).collect();
        let mut rows = statement.query(params.as_slice()).unwrap();
        let mut plan = Vec::new();
        while let Some(row) = rows.next().unwrap() {
            plan.push(row.get::<_, String>(3).unwrap());
        }
        plan.join("\n")
    }

    pub fn response(outcome: &HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(bytes).unwrap(),
            other => panic!("expected a reply, got {other:?}"),
        }
    }

    pub fn detail_field(outcome: &HandlerOutcome) -> Value {
        match outcome {
            HandlerOutcome::ErrorWithDetail { detail, .. } => detail.clone(),
            other => panic!("expected a detail refusal, got {other:?}"),
        }
    }
}

#[cfg(test)]
fn detail_field(outcome: &HandlerOutcome) -> Value {
    tests_support::detail_field(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::McModuleConfig, McHandler, SessionBinding};
    use subc_client_rs::ModuleHandler;
    use subc_protocol::Principal;
    use syn::visit::Visit;

    #[test]
    fn combined_read_adapter_uses_the_serving_stores_and_rejects_writes() {
        let dir = tempfile::tempdir().unwrap();
        let store = tests_support::open_store(dir.path());
        let ctx = AppReadContext::for_test(store, 1);
        ctx.with_reads(|context, store| {
            for (connection, file) in [(context, "context.db"), (store, "store.db")] {
                let path: String = connection.query_row(
                    "SELECT file FROM pragma_database_list WHERE name = 'main'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(Path::new(&path), dir.path().join(file));
                let refused = connection
                    .query_row("CREATE TABLE denied_read_write(id INTEGER)", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .unwrap_err();
                assert_eq!(
                    refused.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::ReadOnly)
                );
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn marked_caps_preserve_utf8_and_maximum_escaped_rows_fit_the_budget() {
        let mut row = json!({"title": "ab😀z", "metadata_json": "{\"value\":\"😀😀\"}"});
        cap_field(&mut row, "title", 6, false);
        assert_eq!(row["title"], "ab😀");
        assert_eq!(row["title_bytes"], 7);
        assert_eq!(row["title_truncated"], true);
        cap_field(&mut row, "metadata_json", 8, true);
        assert!(row["metadata_json"].is_null());
        assert_eq!(row["metadata_json_truncated"], true);
        let maximum =
            json!({"question": "\u{1}".repeat(16 * 1024), "answer": "\u{1}".repeat(16 * 1024)});
        let mut page = Page::new(envelope::ROW_BUDGET);
        assert!(page.try_push(maximum.clone()));
        assert!(page.try_push(maximum.clone()));
        assert!(!page.try_push(maximum));
        assert!(serde_json::to_vec(&page.rows()).unwrap().len() < envelope::ROW_BUDGET);
    }

    #[test]
    fn progress_handler_is_cleared_before_the_next_ordinary_query() {
        const WORK: &str = "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 100000) SELECT sum(x) FROM n";
        for database in ["context", "store"] {
            for ending in ["success", "interrupted", "panic"] {
                let dir = tempfile::tempdir().unwrap();
                let store = tests_support::open_store(dir.path());
                let mut ctx = AppReadContext::for_test(Arc::clone(&store), 1);
                ctx.set_budget(Duration::from_millis(1));
                let read = |conn: &rusqlite::Connection| {
                    if ending == "panic" {
                        panic!("read callback panic");
                    }
                    if ending == "interrupted" {
                        conn.query_row(WORK, [], |row| row.get::<_, i64>(0))?;
                    }
                    Ok(())
                };
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    if database == "context" {
                        ctx.with_context_read(read)
                    } else {
                        ctx.with_store_read(read)
                    }
                }));
                match ending {
                    "success" => result.unwrap().unwrap(),
                    "interrupted" => {
                        assert_eq!(code(result.unwrap().unwrap_err()), "read_budget_exceeded")
                    }
                    _ => assert!(result.is_err()),
                }
                std::thread::sleep(Duration::from_millis(2));
                let ordinary = |conn: &rusqlite::Connection| {
                    conn.query_row(WORK, [], |row| row.get::<_, i64>(0))
                };
                let result = if database == "context" {
                    store.with_context_read(ordinary)
                } else {
                    store.with_store_read(ordinary)
                };
                assert_eq!(result.unwrap(), 5_000_050_000, "{database}/{ending}");
                let same_connection = |conn: &rusqlite::Connection| {
                    {
                        let _deadline = ReadDeadline::install(conn, Duration::ZERO);
                    }
                    conn.query_row(WORK, [], |row| row.get::<_, i64>(0))
                };
                let result = if database == "context" {
                    store.with_context_read(same_connection)
                } else {
                    store.with_store_read(same_connection)
                };
                assert_eq!(
                    result.unwrap(),
                    5_000_050_000,
                    "same connection/{database}/{ending}"
                );
            }
        }
    }

    #[test]
    fn interrupted_list_keeps_rows_and_reports_an_incomplete_page() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = AppReadContext::for_test(tests_support::open_store(dir.path()), 1);
        ctx.set_budget(Duration::from_millis(20));
        let (rows, incomplete) = ctx.with_context_read(|conn| {
            let mut statement = conn.prepare("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) SELECT x FROM n")?;
            let mut rows = statement.query([])?;
            let mut page = Vec::new();
            let mut interrupted = false;
            while let Some(row) = next_row(&mut rows, &mut interrupted)? {
                page.push(row.get::<_, i64>(0)?);
                if page.len() == 1 { std::thread::sleep(Duration::from_millis(30)); }
            }
            Ok((page, interrupted))
        }).unwrap();
        assert!(incomplete);
        assert_eq!(rows[0], 1);
        assert!(
            rows.len() < 1000,
            "SQLite did not interrupt the remaining work"
        );
    }

    fn code(outcome: HandlerOutcome) -> String {
        match outcome {
            HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => {
                code
            }
            other => panic!("expected refusal, got {other:?}"),
        }
    }

    // The handler's process-wide historian budget reads user config on first use.
    // Construct handlers only in fresh children with an empty temporary home.
    pub(super) fn isolated(test: &str) -> bool {
        if std::env::var("MC_APP_READ_ISOLATED_TEST").as_deref() == Ok(test) {
            return false;
        }
        let home = tempfile::tempdir().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env("MC_APP_READ_ISOLATED_TEST", test)
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("XDG_CONFIG_HOME", home.path())
            .env("XDG_DATA_HOME", home.path())
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("running 1 test"),
            "isolated test filter did not run {test}"
        );
        assert!(
            output.status.success(),
            "isolated {test}:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        true
    }

    async fn app_handler() -> McHandler {
        let handler = McHandler::new();
        let decision = handler.on_bind(&admission::tests::phone_bind()).await;
        assert!(format!("{decision:?}").contains("Accept"), "{decision:?}");
        assert!(!handler.bindings.lock().unwrap().contains_key(&1));
        handler
    }

    #[tokio::test]
    async fn app_op_unknown_never_falls_through() {
        if isolated("app_read::tests::app_op_unknown_never_falls_through") {
            return;
        }
        let handler = app_handler().await;
        for method in [
            "transform",
            "mc.flush",
            "ctx_reduce",
            "session.flush",
            "session.read",
            "reply.page",
            "other",
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
            assert_eq!(
                code(handler.handle_channel(1, body).await),
                "app_op_unknown",
                "{method}"
            );
        }
        for method in [
            "context.states",
            "context.compartment",
            "context.search",
            "context.cache_why",
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
            assert_eq!(
                code(handler.handle_channel(1, body).await),
                "app_op_unknown",
                "unimplemented {method}"
            );
        }
    }

    #[tokio::test]
    async fn implemented_reads_are_reachable_on_an_app_channel_only() {
        if isolated("app_read::tests::implemented_reads_are_reachable_on_an_app_channel_only") {
            return;
        }
        let handler = app_handler().await;
        for method in [
            "session_data.read",
            "project_memory.read",
            "dreamer.read",
            "store.health",
            "config.read",
            "config.embedding_probe",
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"method": method, "params": {}})).unwrap();
            let outcome = handler.handle_channel(1, body).await;
            let outcome = match outcome {
                HandlerOutcome::Response(_) => "response".to_string(),
                HandlerOutcome::Error { code, .. }
                | HandlerOutcome::ErrorWithDetail { code, .. } => code,
                other => panic!("{method}: {other:?}"),
            };
            assert_ne!(outcome, "app_op_unknown", "{method}");
            assert!(
                outcome != "bad_request" && outcome != "route_unbound",
                "{method}: {outcome}"
            );
        }
        let handler = McHandler::new();
        handler.bind_route(
            2,
            SessionBinding {
                principal: Some(Principal::Direct),
                scope: None,
                project_root: "fixture-project".into(),
                harness: "opencode".into(),
                session: "fixture-session".into(),
                model_key: None,
                config: McModuleConfig::default(),
                history_budget_tokens: 1000.0,
            },
        );
        for method in [
            "session_data.read",
            "project_memory.read",
            "dreamer.read",
            "store.health",
            "config.read",
            "config.embedding_probe",
        ] {
            let body =
                serde_json::to_vec(&serde_json::json!({"method": method, "params": {}})).unwrap();
            assert_eq!(
                code(handler.handle_channel(2, body).await),
                "app_caller_forbidden",
                "plugin route {method}"
            );
        }
    }

    #[tokio::test]
    async fn app_methods_refused_on_plugin_harness_and_flow_routes() {
        if isolated("app_read::tests::app_methods_refused_on_plugin_harness_and_flow_routes") {
            return;
        }
        let handler = McHandler::new();
        for (channel, harness, principal, scope) in [
            (2, "opencode", Some(Principal::Direct), None),
            (
                3,
                "thalamus",
                Some(Principal::Reserved {
                    module_id: "thalamus-harness".into(),
                }),
                None,
            ),
            (
                4,
                "basal",
                Some(Principal::Reserved {
                    module_id: "basal".into(),
                }),
                Some(admission::tests::scope("flow_id")),
            ),
        ] {
            handler.bind_route(
                channel,
                SessionBinding {
                    principal,
                    scope,
                    project_root: "fixture-project".into(),
                    harness: harness.into(),
                    session: "fixture-session".into(),
                    model_key: None,
                    config: McModuleConfig::default(),
                    history_budget_tokens: 1000.0,
                },
            );
            for method in APP_READ_METHODS {
                let body =
                    serde_json::to_vec(&serde_json::json!({"method":method,"params":{}})).unwrap();
                assert_eq!(
                    code(handler.handle_channel(channel, body).await),
                    "app_caller_forbidden",
                    "{harness}: {method}"
                );
            }
        }
    }

    #[tokio::test]
    async fn route_gone_removes_app_channel_before_reuse() {
        if isolated("app_read::tests::route_gone_removes_app_channel_before_reuse") {
            return;
        }
        let handler = app_handler().await;
        handler
            .on_route_gone(&admission::tests::phone_bind().handle)
            .await;
        let body = br#"{"method":"context.states","params":{}}"#.to_vec();
        assert_eq!(code(handler.handle_channel(1, body).await), "route_unbound");
        assert!(!handler.app_channels.lock().unwrap().contains_key(&1));
    }

    #[test]
    fn app_manifest_is_internal_and_not_agent_facing() {
        let manifest = crate::manifest_with_route_targets_and_smart_notes(
            crate::DEFAULT_MODULE_ID,
            &crate::route_targets::RouteTargetConfig::default(),
            true,
        );
        let value = serde_json::to_value(manifest).unwrap();
        let provides = value["provides"].as_array().unwrap();
        let app = provides
            .iter()
            .find(|role| role["service_id"] == SERVICE_ID)
            .expect("app service manifest");
        assert_eq!(app["agent_facing"], false);
        assert_eq!(app["transport"], "bulk");
        assert_eq!(app["operations"], serde_json::json!(APP_READ_METHODS));
        for role in provides
            .iter()
            .filter(|role| role["service_id"] != SERVICE_ID)
        {
            let encoded = serde_json::to_string(role).unwrap();
            for method in APP_READ_METHODS {
                assert!(!encoded.contains(method), "{method} leaked to another role");
            }
        }
    }

    #[test]
    fn trait_handle_is_exact_channel_delegation() {
        let source = syn::parse_file(include_str!("../lib.rs")).unwrap();
        let module_handler = source
            .items
            .iter()
            .find_map(|item| match item {
                syn::Item::Impl(item)
                    if item.trait_.as_ref().is_some_and(|(_, path, _)| {
                        path.segments.last().unwrap().ident == "ModuleHandler"
                    }) =>
                {
                    Some(item)
                }
                _ => None,
            })
            .unwrap();
        let handle = module_handler
            .items
            .iter()
            .find_map(|item| match item {
                syn::ImplItem::Fn(f) if f.sig.ident == "handle" => Some(f),
                _ => None,
            })
            .unwrap();
        let expected: syn::Block =
            syn::parse_quote!({ self.handle_channel(ctx.route_handle().channel, body).await });
        assert_eq!(quote::quote!(#expected).to_string(), {
            let block = &handle.block;
            quote::quote!(#block).to_string()
        });
    }

    fn forbidden_name(name: &str) -> bool {
        let name = name.strip_prefix("r#").unwrap_or(name);
        matches!(
            name,
            "HostStore"
                | "execute"
                | "execute_batch"
                | "raw_execute"
                | "pragma_update"
                | "pragma_update_and_check"
                | "with_domain_transaction"
                | "try_domain_transaction"
                | "with_facade_command"
                | "with_facade_mutation"
                | "promote_facts"
                | "arm_soft_refresh"
                | "replace_compartments"
                | "truncate_compartments_for_revert"
                | "reset_session_for_recomp"
                | "merge_memories"
                | "archive_memory"
                | "archive_memories"
                | "dismiss_note"
                | "dismiss_note_cas"
                | "transition_note"
                | "claim_due_note"
                | "admit_memory"
                | "admit_provider_pass"
                | "apply_authority_state_sync"
                | "ops_flush"
                | "ops_flush_in_project"
                | "heartbeat_historian_run"
                | "reconcile_provider_drop_targets"
                | "queue_provider_drops"
                | "consume_provider_drops"
        ) || [
            "insert_",
            "update_",
            "upsert_",
            "delete_",
            "save_",
            "commit",
            "publish_",
            "record_",
            "append_",
            "set_memory_",
            "set_todo_",
            "set_provider_",
            "trace_pass_",
            "abandon_",
            "drain_",
            "acquire_",
            "renew_",
            "release_",
            "resume_",
            "clear_async_",
            "prune_",
            "copy_async_",
            "retire_",
            "async_compaction_save",
            "reserve_",
            "adopt_",
            "mark_async_",
            "finish_",
            "cancel_historian_",
            "claim_historian_",
            "republish_",
            "park_",
            "expire_historian_",
            "discard_staged_",
            "write_note_",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    }

    #[derive(Default)]
    struct ReadOnlySource {
        violations: Vec<String>,
    }

    impl ReadOnlySource {
        fn tokens(&mut self, tokens: proc_macro2::TokenStream) {
            for token in tokens {
                match token {
                    proc_macro2::TokenTree::Ident(ident) if forbidden_name(&ident.to_string()) => {
                        self.violations.push(ident.to_string())
                    }
                    proc_macro2::TokenTree::Group(group) => self.tokens(group.stream()),
                    proc_macro2::TokenTree::Literal(lit) => {
                        if let Ok(lit) = syn::parse_str::<syn::LitStr>(&lit.to_string()) {
                            self.sql(&lit.value());
                        }
                    }
                    _ => {}
                }
            }
        }

        fn sql(&mut self, value: &str) {
            let words: Vec<_> = value
                .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                .filter(|word| !word.is_empty())
                .map(str::to_ascii_uppercase)
                .collect();
            if words.windows(2).any(|pair| pair == ["BEGIN", "IMMEDIATE"]) {
                self.violations.push("immediate write transaction".into());
            }
        }
    }

    impl<'ast> Visit<'ast> for ReadOnlySource {
        fn visit_ident(&mut self, ident: &'ast syn::Ident) {
            if forbidden_name(&ident.to_string()) {
                self.violations.push(ident.to_string());
            }
        }
        fn visit_lit_str(&mut self, lit: &'ast syn::LitStr) {
            self.sql(&lit.value());
        }
        fn visit_macro(&mut self, mac: &'ast syn::Macro) {
            self.visit_path(&mac.path);
            self.tokens(mac.tokens.clone());
        }
    }

    fn scan(path: &std::path::Path) {
        for entry in std::fs::read_dir(path).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(&path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let source = std::fs::read_to_string(&path).unwrap();
                let syntax = syn::parse_file(&source).unwrap();
                let mut visitor = ReadOnlySource::default();
                visitor.visit_file(&syntax);
                assert!(
                    visitor.violations.is_empty(),
                    "{} contains write access: {:?}",
                    path.display(),
                    visitor.violations
                );
            }
        }
    }

    #[test]
    fn app_read_sources_are_read_only() {
        scan(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/app_read"));
    }

    #[test]
    fn source_guard_detects_writer_paths_calls_and_macros() {
        for source in [
            "fn bad() { db.execute(\"SQL\", []); }",
            "type Bad = crate::host_store::HostStore;",
            "fn bad() { db.insert_memory(row); }",
            "fn bad() { m!(db.execute_batch(sql)); }",
        ] {
            let mut visitor = ReadOnlySource::default();
            visitor.visit_file(&syn::parse_file(source).unwrap());
            assert!(!visitor.violations.is_empty(), "missed {source}");
        }
        let source = format!(
            "fn bad() {{ db.query_row(\"{} {};\", [], row); }}",
            "BEGIN", "IMMEDIATE"
        );
        let mut visitor = ReadOnlySource::default();
        visitor.visit_file(&syn::parse_file(&source).unwrap());
        assert!(!visitor.violations.is_empty(), "missed write transaction");
    }
}
