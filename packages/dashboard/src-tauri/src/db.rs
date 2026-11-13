use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use crate::external_cache_sessions;
use crate::pi_sessions;
use crate::project_identity::{basename, normalize_stored_project_path};
#[path = "compartment_scores.rs"]
mod compartment_scores;
#[path = "historian_telemetry.rs"]
mod historian_telemetry;
#[cfg(test)]
use crate::schema_fixture;
pub use historian_telemetry::{count_historian_runs, get_subagent_invocations, SubagentInvocation};

pub fn resolve_db_path() -> Option<PathBuf> {
    // Keep the dashboard on the same harness-side database as the plugin. An
    // explicit override is a complete absolute storage directory; do not fall
    // back to XDG/legacy paths when it is invalid or the DB is not created yet.
    if let Ok(raw) = std::env::var("MAGIC_CONTEXT_STORAGE_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let explicit = PathBuf::from(trimmed);
            if !explicit.is_absolute() {
                return None;
            }
            let path = explicit.join("context.db");
            return path.exists().then_some(path);
        }
    }

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

#[cfg(test)]
mod storage_path_tests {
    use super::resolve_db_path;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn explicit_absolute_storage_override_beats_xdg_and_rejects_relative() {
        let mut env = crate::test_env::EnvGuard::new();
        let root = tempfile::tempdir().unwrap();
        let explicit = root.path().join("shared");
        fs::create_dir_all(&explicit).unwrap();
        let explicit_db = explicit.join("context.db");
        fs::write(&explicit_db, b"sqlite-fixture").unwrap();
        let xdg = root.path().join("xdg");
        fs::create_dir_all(xdg.join("cortexkit/magic-context")).unwrap();
        let xdg_db = xdg.join("cortexkit/magic-context/context.db");
        fs::write(&xdg_db, b"xdg-fixture").unwrap();

        env.set("MAGIC_CONTEXT_STORAGE_DIR", &explicit);
        env.set("XDG_DATA_HOME", &xdg);
        assert!(resolve_db_path().unwrap().starts_with(root.path()));
        assert_eq!(resolve_db_path(), Some(PathBuf::from(&explicit_db)));

        env.set("MAGIC_CONTEXT_STORAGE_DIR", "relative/shared");
        assert_eq!(resolve_db_path(), None);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenCodeDbResolution {
    pub path: PathBuf,
    pub source: &'static str,
    pub channel: Option<String>,
}

#[derive(Debug, Clone)]
struct CachedOpenCodeDbResolution {
    key: String,
    resolution: OpenCodeDbResolution,
    existed: bool,
}

static OPENCODE_DB_RESOLUTION: OnceLock<RwLock<Option<CachedOpenCodeDbResolution>>> =
    OnceLock::new();

fn opencode_data_dir() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_default()
                .join(".local")
                .join("share")
        })
        .join("opencode")
}

fn opencode_resolution_key(data_dir: &Path, overrides: &OpenCodeDbOverrides) -> String {
    [
        data_dir.to_string_lossy().to_string(),
        overrides.explicit.clone().unwrap_or_default(),
        overrides.disable_channel_db.clone().unwrap_or_default(),
        overrides.channel.clone().unwrap_or_default(),
    ]
    .join("\0")
}

fn opencode_channel_path(data_dir: &Path, channel: &str) -> PathBuf {
    if matches!(channel, "latest" | "beta" | "prod") {
        data_dir.join("opencode.db")
    } else {
        data_dir.join(format!("opencode-{channel}.db"))
    }
}

fn opencode_candidate_names(data_dir: &Path) -> Vec<String> {
    let mut names = vec![
        "opencode.db".to_string(),
        "opencode-local.db".to_string(),
        "opencode-dev.db".to_string(),
    ];
    let mut discovered = std::fs::read_dir(data_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let dynamic = name.starts_with("opencode-") && name.ends_with(".db");
            (dynamic && !names.contains(&name)).then_some(name)
        })
        .collect::<Vec<_>>();
    discovered.sort();
    names.extend(discovered);
    names
}

fn discover_opencode_db(data_dir: &Path) -> OpenCodeDbResolution {
    let mut selected: Option<(PathBuf, u128, usize)> = None;
    for (order, name) in opencode_candidate_names(data_dir).into_iter().enumerate() {
        let path = data_dir.join(&name);
        let Some(modified) = std::fs::metadata(&path)
            .ok()
            .filter(|metadata| metadata.is_file())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
        else {
            continue;
        };
        let replace = selected
            .as_ref()
            .map_or(true, |(_, best_modified, best_order)| {
                modified > *best_modified || (modified == *best_modified && order < *best_order)
            });
        if replace {
            selected = Some((path, modified, order));
        }
    }

    let Some((path, _, _)) = selected else {
        return OpenCodeDbResolution {
            path: data_dir.join("opencode.db"),
            source: "default",
            channel: None,
        };
    };
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let channel = if name == "opencode.db" {
        None
    } else {
        name.strip_prefix("opencode-")
            .and_then(|value| value.strip_suffix(".db"))
            .map(str::to_string)
    };
    OpenCodeDbResolution {
        path,
        source: "discovered",
        channel,
    }
}

#[derive(Default)]
pub struct OpenCodeDbOverrides {
    pub explicit: Option<String>,
    pub disable_channel_db: Option<String>,
    pub channel: Option<String>,
}

/// Resolve the OpenCode store without consulting process environment or cache.
pub fn resolve_opencode_db_for(
    data_home: &Path,
    overrides: &OpenCodeDbOverrides,
) -> OpenCodeDbResolution {
    let data_dir = &data_home.join("opencode");
    if let Some(explicit) = overrides
        .explicit
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let raw = PathBuf::from(explicit);
        return OpenCodeDbResolution {
            path: if explicit == ":memory:" || raw.is_absolute() {
                raw
            } else {
                data_dir.join(raw)
            },
            source: "OPENCODE_DB",
            channel: None,
        };
    }

    if matches!(overrides.disable_channel_db.as_deref(), Some("1" | "true")) {
        return OpenCodeDbResolution {
            path: data_dir.join("opencode.db"),
            source: "default",
            channel: None,
        };
    }

    if let Some(channel) = overrides
        .channel
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return OpenCodeDbResolution {
            path: opencode_channel_path(data_dir, channel),
            source: "channel",
            channel: Some(channel.to_string()),
        };
    }

    discover_opencode_db(data_dir)
}

pub fn resolve_opencode_db() -> OpenCodeDbResolution {
    let data_home = data_home();
    let overrides = opencode_overrides();
    let key = opencode_resolution_key(&data_home, &overrides);
    let cache = OPENCODE_DB_RESOLUTION.get_or_init(|| RwLock::new(None));
    if let Ok(guard) = cache.read() {
        if let Some(cached) = guard.as_ref() {
            if cached.key == key && cached.existed && cached.resolution.path.exists() {
                return cached.resolution.clone();
            }
        }
    }
    let resolution = resolve_opencode_db_for(&data_home, &overrides);
    let existed = resolution.path != Path::new(":memory:") && resolution.path.exists();
    if let Ok(mut guard) = cache.write() {
        *guard = Some(CachedOpenCodeDbResolution {
            key,
            resolution: resolution.clone(),
            existed,
        });
    }
    resolution
}

pub fn data_home() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".local/share"))
}

pub fn opencode_overrides() -> OpenCodeDbOverrides {
    OpenCodeDbOverrides {
        explicit: std::env::var("OPENCODE_DB").ok(),
        disable_channel_db: std::env::var("OPENCODE_DISABLE_CHANNEL_DB").ok(),
        channel: std::env::var("OPENCODE_CHANNEL").ok(),
    }
}

mod opencode_stores;
#[cfg(test)]
mod opencode_stores_tests;
pub(crate) use opencode_stores::{
    configured_store_values, parse_runner_roots, read_store, readable_opencode_stores,
    runner_roots_path, store_list_for, ReadableStore,
};
pub use opencode_stores::{opencode_store_rows, OpenCodeStoreRow, StoreOrigin};

/// Runs `read` on every readable OpenCode store, in store-list order, with
/// that store's session index, and returns what each read produced. A store
/// that cannot be opened, or whose generation is unknown, is skipped.
fn for_each_opencode_store<T>(
    stores: &[ReadableStore],
    mut read: impl FnMut(&ReadableStore, &Connection, &OpenCodeSessions) -> T,
) -> Vec<T> {
    stores
        .iter()
        .filter_map(|store| {
            read_store(&store.path, |conn| {
                let sessions = resolve_opencode_sessions(conn).ok()?;
                Some(read(store, conn, &sessions))
            })
            .ok()
            .flatten()
        })
        .collect()
}

/// Runs `read` on the first store, in store-list order, that holds
/// `session_id`. Session ids are unique across OpenCode stores; when a copied
/// store holds the same id twice, the store listed first wins, which is the
/// same store the merged lists show the session from. The index passed to
/// `read` knows only this session's owner, found with one primary-key probe
/// per generation rather than a scan of every session id.
fn with_opencode_session_store<T>(
    session_id: &str,
    mut read: impl FnMut(&Connection, OpenCodeStoreGeneration) -> T,
) -> Option<T> {
    readable_opencode_stores().iter().find_map(|store| {
        read_store(&store.path, |conn| {
            let generation = opencode_session_owner(conn, session_id).ok()??;
            Some(read(conn, generation))
        })
        .ok()
        .flatten()
    })
}

/// The generation that owns `session_id` in this store, if any: the latest
/// generation whose session table holds the id, as `resolve_opencode_sessions`
/// decides for every id.
fn opencode_session_owner(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<OpenCodeStoreGeneration>, rusqlite::Error> {
    for &generation in opencode_store_generations(conn)?.iter().rev() {
        let table = opencode_session_table(generation);
        if table_exists(conn, table)
            && conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
                [session_id],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(Some(generation));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeStoreGeneration {
    V1,
    V2,
}

#[derive(Debug)]
struct OpenCodeSessions {
    generations: Vec<OpenCodeStoreGeneration>,
    owners: HashMap<String, OpenCodeStoreGeneration>,
}

impl OpenCodeSessions {
    fn owner(&self, id: &str) -> Option<OpenCodeStoreGeneration> {
        self.owners.get(id).copied()
    }

    fn owns(&self, id: &str, generation: OpenCodeStoreGeneration) -> bool {
        self.owner(id) == Some(generation)
    }
}

fn resolve_opencode_sessions(conn: &Connection) -> Result<OpenCodeSessions, rusqlite::Error> {
    let generations = opencode_store_generations(conn)?;
    let mut owners = HashMap::new();
    for &generation in &generations {
        if !table_exists(conn, opencode_session_table(generation)) {
            continue;
        }
        let mut stmt = conn.prepare(&format!(
            "SELECT id FROM {}",
            opencode_session_table(generation)
        ))?;
        for id in stmt.query_map([], |row| row.get::<_, String>(0))? {
            owners.insert(id?, generation);
        }
    }
    Ok(OpenCodeSessions {
        generations,
        owners,
    })
}

/// The session generations an OpenCode store holds, oldest first. A later
/// generation's row owns an id both tables hold.
fn opencode_store_generations(
    conn: &Connection,
) -> Result<Vec<OpenCodeStoreGeneration>, rusqlite::Error> {
    let mut generations = Vec::new();
    // OpenCode 1 can create session_message before an upgrade, so its
    // presence alone does not identify V2. Only a populated session_v2
    // alongside session_message adds V2 ownership to a mixed store.
    let has_v1 = table_exists(conn, "session");
    let has_v2 = table_exists(conn, "session_message") && table_exists(conn, "session_v2");
    if has_v1 {
        generations.push(OpenCodeStoreGeneration::V1);
    }
    if has_v2
        && (!has_v1
            || conn.query_row("SELECT EXISTS(SELECT 1 FROM session_v2)", [], |row| {
                row.get::<_, bool>(0)
            })?)
    {
        generations.push(OpenCodeStoreGeneration::V2);
    }
    if generations.is_empty() && table_exists(conn, "project") {
        generations.push(OpenCodeStoreGeneration::V1);
    }
    if generations.is_empty() {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "OpenCode store generation is unknown",
            ),
        )));
    }
    Ok(generations)
}

#[cfg(test)]
fn opencode_store_generation(
    conn: &Connection,
) -> Result<OpenCodeStoreGeneration, rusqlite::Error> {
    let table_exists = |name: &str| -> Result<bool, rusqlite::Error> {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [name],
            |row| row.get(0),
        )
    };
    // These schema tests preserve recognition of older message/part and
    // session/project layouts; production readers resolve session ownership.
    if table_exists("message")? && table_exists("part")? {
        return Ok(OpenCodeStoreGeneration::V1);
    }
    if table_exists("session_message")? {
        return Ok(OpenCodeStoreGeneration::V2);
    }
    if table_exists("session")? || table_exists("project")? {
        return Ok(OpenCodeStoreGeneration::V1);
    }
    Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "OpenCode store generation is unknown; refusing generation-specific database access",
        ),
    )))
}

/// The session table for one generation. Converted stores retain `session`
/// alongside `session_v2`; the session index selects which row owns each ID.
fn opencode_session_table(generation: OpenCodeStoreGeneration) -> &'static str {
    match generation {
        OpenCodeStoreGeneration::V1 => "session",
        OpenCodeStoreGeneration::V2 => "session_v2",
    }
}

fn opencode_db_probe_descriptions(resolution: &OpenCodeDbResolution) -> Vec<String> {
    let channel_db_disabled = matches!(
        std::env::var("OPENCODE_DISABLE_CHANNEL_DB").as_deref(),
        Ok("1" | "true")
    );
    if resolution.source == "OPENCODE_DB" || resolution.source == "channel" || channel_db_disabled {
        return vec![resolution.path.to_string_lossy().to_string()];
    }
    let data_dir = resolution
        .path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(opencode_data_dir);
    vec![
        data_dir.join("opencode.db").to_string_lossy().to_string(),
        data_dir
            .join("opencode-local.db")
            .to_string_lossy()
            .to_string(),
        data_dir
            .join("opencode-dev.db")
            .to_string_lossy()
            .to_string(),
        data_dir
            .join("opencode-<channel>.db")
            .to_string_lossy()
            .to_string(),
    ]
}

fn opencode_db_missing_message(resolution: &OpenCodeDbResolution) -> String {
    format!(
        "Magic Context cannot find OpenCode's session database (looked for {}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.",
        opencode_db_probe_descriptions(resolution).join(", ")
    )
}

#[cfg(test)]
mod opencode_store_generation_tests {
    use super::*;

    fn store_with(tables: &[&str]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        for table in tables {
            conn.execute_batch(&format!("CREATE TABLE {table} (id TEXT PRIMARY KEY)"))
                .unwrap();
        }
        conn
    }

    // Table set observed on a live OpenCode 1.18.30 store: the 1.x host already ships
    // session_message and session_v2 beside its own message/part tables, so the
    // presence of session_message must not classify the store as OpenCode 2.
    #[test]
    fn v1_store_carrying_session_message_stays_v1() {
        let conn = store_with(&[
            "message",
            "part",
            "project",
            "session",
            "session_message",
            "session_v2",
        ]);
        assert_eq!(
            opencode_store_generation(&conn).unwrap(),
            OpenCodeStoreGeneration::V1
        );
    }

    #[test]
    fn v2_store_without_v1_message_tables_is_v2() {
        let conn = store_with(&["project", "session_message", "session_v2", "workspace"]);
        assert_eq!(
            opencode_store_generation(&conn).unwrap(),
            OpenCodeStoreGeneration::V2
        );
    }

    #[test]
    fn v1_store_without_session_message_is_v1() {
        let conn = store_with(&["message", "part", "project", "session"]);
        assert_eq!(
            opencode_store_generation(&conn).unwrap(),
            OpenCodeStoreGeneration::V1
        );
    }

    #[test]
    fn schemaless_store_is_refused() {
        let conn = store_with(&[]);
        assert!(opencode_store_generation(&conn).is_err());
    }
}

#[cfg(test)]
mod opencode_path_tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn data_dir() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().join("opencode");
        fs::create_dir_all(&data_dir).unwrap();
        (root, data_dir)
    }

    #[test]
    fn explicit_override_disable_and_channel_follow_opencode_order() {
        let (_root, data_dir) = data_dir();
        let absolute = data_dir.join("absolute.db");
        assert_eq!(
            resolve_opencode_db_for(
                data_dir.parent().unwrap(),
                &OpenCodeDbOverrides {
                    explicit: absolute.to_str().map(str::to_string),
                    disable_channel_db: Some("true".to_string()),
                    channel: Some("dev".to_string())
                }
            ),
            OpenCodeDbResolution {
                path: absolute,
                source: "OPENCODE_DB",
                channel: None,
            }
        );
        assert_eq!(
            resolve_opencode_db_for(
                data_dir.parent().unwrap(),
                &OpenCodeDbOverrides {
                    explicit: Some("relative.db".to_string()),
                    disable_channel_db: None,
                    channel: None
                }
            )
            .path,
            data_dir.join("relative.db")
        );
        assert_eq!(
            resolve_opencode_db_for(
                data_dir.parent().unwrap(),
                &OpenCodeDbOverrides {
                    explicit: None,
                    disable_channel_db: Some("1".to_string()),
                    channel: Some("dev".to_string())
                }
            ),
            OpenCodeDbResolution {
                path: data_dir.join("opencode.db"),
                source: "default",
                channel: None,
            }
        );
        assert_eq!(
            resolve_opencode_db_for(
                data_dir.parent().unwrap(),
                &OpenCodeDbOverrides {
                    explicit: None,
                    disable_channel_db: None,
                    channel: Some("dev".to_string())
                }
            ),
            OpenCodeDbResolution {
                path: data_dir.join("opencode-dev.db"),
                source: "channel",
                channel: Some("dev".to_string()),
            }
        );
        assert_eq!(
            resolve_opencode_db_for(
                data_dir.parent().unwrap(),
                &OpenCodeDbOverrides {
                    explicit: Some(":memory:".to_string()),
                    disable_channel_db: None,
                    channel: None
                }
            )
            .path,
            PathBuf::from(":memory:")
        );
    }

    #[test]
    fn discovery_selects_each_candidate_when_it_is_newest() {
        for selected in [
            "opencode.db",
            "opencode-local.db",
            "opencode-dev.db",
            "opencode-nightly.db",
        ] {
            let (_root, data_dir) = data_dir();
            for name in [
                "opencode.db",
                "opencode-local.db",
                "opencode-dev.db",
                "opencode-nightly.db",
            ] {
                if name != selected {
                    fs::write(data_dir.join(name), b"old").unwrap();
                }
            }
            std::thread::sleep(Duration::from_millis(10));
            fs::write(data_dir.join(selected), b"newest").unwrap();
            let resolution = discover_opencode_db(&data_dir);
            assert_eq!(resolution.path, data_dir.join(selected));
            assert_eq!(resolution.source, "discovered");
            assert_eq!(
                resolution.channel,
                (selected != "opencode.db")
                    .then(|| selected["opencode-".len()..selected.len() - ".db".len()].to_string())
            );
        }
    }

    #[test]
    fn missing_opencode_store_has_the_named_condition_text() {
        let (_root, data_dir) = data_dir();
        let resolution = discover_opencode_db(&data_dir);
        assert_eq!(
            resolution,
            OpenCodeDbResolution {
                path: data_dir.join("opencode.db"),
                source: "default",
                channel: None,
            }
        );
        let condition = opencode_db_missing_condition(&resolution);
        assert_eq!(condition.code, "opencode_db_missing");
        assert_eq!(
            condition.message,
            format!(
                "Magic Context cannot find OpenCode's session database (looked for {}, {}, {}, {}). History compaction (historian) and the mid-turn valve are disabled until it is found; set OPENCODE_DB if OpenCode stores it elsewhere.",
                data_dir.join("opencode.db").to_string_lossy(),
                data_dir.join("opencode-local.db").to_string_lossy(),
                data_dir.join("opencode-dev.db").to_string_lossy(),
                data_dir.join("opencode-<channel>.db").to_string_lossy(),
            )
        );
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
    crate::db_capabilities::get(&conn)?;
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
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    );
    crate::writer_diagnostics::statement("context_store_uuid", || {
        conn.execute(
        "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?1) ON CONFLICT(key) DO NOTHING",
        [&uuid],
    )
    })?;
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
    crate::db_capabilities::get(&conn)?;
    Ok(conn)
}

// ── Memory types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct Memory {
    pub revision: i64,
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

/// Filters for [`get_memory_stats_scoped`]. Summary totals stay project-scoped.
/// `categories` follows the memory list: an exact status, or archived rows
/// omitted unless `include_archived` is set, plus the same search text.
#[derive(Clone, Copy)]
pub struct MemoryStatsScope<'a> {
    pub project: Option<&'a str>,
    pub workspace_id: Option<i64>,
    pub status: Option<&'a str>,
    pub search: Option<&'a str>,
    pub include_archived: bool,
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
    Opencode2,
    Pi,
    Omp,
    Broca,
    ClaudeCode,
    Codex,
}

impl Harness {
    fn as_str(self) -> &'static str {
        match self {
            Self::Opencode => "opencode",
            Self::Opencode2 => "opencode2",
            Self::Pi => "pi",
            Self::Omp => "omp",
            Self::Broca => "broca",
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    fn has_magic_context_plugin_state(self) -> bool {
        matches!(
            self,
            Self::Opencode | Self::Opencode2 | Self::Pi | Self::Omp
        )
    }

    /// Hosts whose Magic Context state lives only in the Rust module's
    /// store.db, keyed by the host's session id.
    fn mc_state_lives_in_store(self) -> bool {
        matches!(self, Self::ClaudeCode | Self::Codex | Self::Broca)
    }

    /// OpenCode 1.x and 2.x are two store generations of the same product: a
    /// converted session keeps its id, so the plugin's context.db may record a
    /// row under `opencode` while the dashboard lists the same session under
    /// `opencode2` (or vice versa). The other harnesses use disjoint id
    /// shapes, so their ids never alias an OpenCode id.
    fn shares_session_ids_with(self, other: Harness) -> bool {
        matches!(
            (self, other),
            (
                Harness::Opencode | Harness::Opencode2,
                Harness::Opencode | Harness::Opencode2
            )
        )
    }

    fn uses_codex_no_write_cache_model(self) -> bool {
        matches!(self, Self::Codex)
    }

    /// The provider behind a JSONL harness's recorded model. Claude Code only
    /// talks to Anthropic models; Codex can be pointed at other providers and
    /// its events do not name one, so it reports the model alone.
    fn jsonl_provider(self) -> Option<&'static str> {
        matches!(self, Self::ClaudeCode).then_some("anthropic")
    }
}

impl std::str::FromStr for Harness {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.to_ascii_lowercase().as_str() {
            "opencode" => Ok(Self::Opencode),
            "opencode2" => Ok(Self::Opencode2),
            "pi" => Ok(Self::Pi),
            "omp" => Ok(Self::Omp),
            "broca" => Ok(Self::Broca),
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
    if let Some(identity) = identities.get(&(harness, session_id.to_string())) {
        return identity.clone();
    }

    // A session recorded under the wrong compatible harness still needs its project
    // on dashboard rows. Compare the complete ID so short-prefix collisions remain
    // isolated by the persisted (harness, session_id) primary key.
    identities
        .iter()
        .find_map(|((_, stored_id), identity)| (stored_id == session_id).then(|| identity.clone()))
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

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct SessionScanCondition {
    pub code: String,
    pub message: String,
}

fn opencode_db_missing_condition(resolution: &OpenCodeDbResolution) -> SessionScanCondition {
    SessionScanCondition {
        code: "opencode_db_missing".to_string(),
        message: opencode_db_missing_message(resolution),
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct PagedSessions {
    pub rows: Vec<SessionRow>,
    pub total: u32,
    pub has_more: bool,
    pub conditions: Vec<SessionScanCondition>,
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
    pub historian_runs: i64,
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
    /// Epoch milliseconds from the OpenCode message table or Pi/OMP JSONL entry
    /// matched by start_message_id.
    pub start_time: Option<i64>,
    /// Epoch milliseconds from the OpenCode message table or Pi/OMP JSONL entry
    /// matched by end_message_id.
    pub end_time: Option<i64>,
    /// v2 decay-rate score (1–100). Higher = decays into lower render tiers
    /// more slowly. Default 50.
    pub importance: i64,
    pub effective_importance: Option<i64>,
    pub applied_importance: Option<i64>,
    /// TypeScript and Rust keep their frozen prompt-history bytes in different
    /// caches. If both exist, show both committed score views; a database row
    /// alone cannot identify which runtime last sent the prompt.
    pub rust_applied_importance: Option<i64>,
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
    pub compartment_in_progress: bool,
    pub system_prompt_hash: String,
    pub memory_block_count: i64,
    pub new_work_tokens: i64,
    pub total_input_tokens: i64,
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
    pub cache_reported: bool,
    pub total_tokens: i64,
    pub hit_ratio: f64,
    pub severity: String,
    pub cause: Option<String>,
    pub agent: Option<String>,
    pub finish: Option<String>,
    #[serde(skip)]
    native_turn_id: Option<String>,
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
    // True when the prompt shrank meaningfully vs the previous step. In a
    // session whose context Magic Context manages (`context_reduced_by_mc`)
    // that is Magic Context reclaiming context (execute-pass drops,
    // comparting), and `cause` carries the reason it recorded. Elsewhere the
    // shrink is not Magic Context's and no Magic Context cause is attached.
    pub is_drop: bool,
    // True when Magic Context manages this session's context, so a drop here
    // is Magic Context's own reclaim. This differs from
    // `SessionCacheStats::managed`, which only decides whether the Cache list
    // shows the session by default (every Broca session is "managed" in that
    // sense, though Magic Context does not manage a Broca run's context unless
    // store.db holds state for it).
    pub context_reduced_by_mc: bool,
    // True for the first row of a session: its opening request had nothing to
    // read from the cache, so a low share there is not a miss.
    pub cold_start: bool,
    // The provider and model that served this request, when recorded.
    pub provider: Option<String>,
    pub model: Option<String>,
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
    /// Set when this session's `last_activity_ms` cannot follow a turn in
    /// progress; the Cache tab shows it so a list that stops moving mid-turn
    /// is explained rather than silent.
    pub activity_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broca: Option<broca_run_index::BrocaSessionSummary>,
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
    cache_reported: bool,
    total_tokens: i64,
    agent: Option<String>,
    finish: Option<String>,
    /// OpenCode's native turn key. Every assistant step spawned by one user
    /// message carries that user message's `parentID`.
    native_turn_id: Option<String>,
    context_limit: Option<i64>,
    provider: Option<String>,
    model: Option<String>,
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

/// Extract the m[1] block containing compartments published since the last fold.
fn extract_new_compartments_slice(m1_text: &str) -> Option<String> {
    const OPEN: &str = "<new-compartments>";
    const CLOSE: &str = "</new-compartments>";
    let start = m1_text.find(OPEN)?;
    let end = m1_text[start..].find(CLOSE)? + start + CLOSE.len();
    Some(m1_text[start..end].to_string())
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
    let payload_query = if table_exists(conn, "session_render_cache")
        && !table_has_column(conn, "session_meta", "cached_m0_bytes")
    {
        "SELECT (SELECT value FROM session_render_cache WHERE session_id = ?1 AND cache_key = 'cached_m0_bytes'),
                (SELECT value FROM session_render_cache WHERE session_id = ?1 AND cache_key = 'cached_m1_bytes')"
    } else {
        "SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?1"
    };
    let (m0_bytes, m1_bytes): (Option<Vec<u8>>, Option<Vec<u8>>) = conn
        .query_row(payload_query, [session_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((None, None));
    let m0_history = m0_bytes
        .as_ref()
        .and_then(|b| String::from_utf8(b.clone()).ok())
        .and_then(|text| extract_session_history_slice(&text));
    let m1_compartments = m1_bytes
        .as_ref()
        .and_then(|b| String::from_utf8(b.clone()).ok())
        .and_then(|text| extract_new_compartments_slice(&text));
    let compartment_tokens = match (m0_history, m1_compartments) {
        (Some(history), new_compartments) => {
            estimate_tokens(history.len() as i64)
                + new_compartments.map_or(0, |block| estimate_tokens(block.len() as i64))
        }
        (None, _) => {
            // No materialized m[0] yet (brand-new / pre-first-materialization).
            // Fall back to the Σp1 estimate so the bucket isn't blank on a cold
            // session; it self-corrects to the decayed size on first render.
            estimate_tokens(
                conn.query_row(
                    "SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + ?2), 0)
                 FROM compartments WHERE session_id = ?1",
                    rusqlite::params![session_id, COMPARTMENT_HEADING_OVERHEAD],
                    |r| r.get(0),
                )
                .unwrap_or(0),
            )
        }
    };

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

    // Read the rendered memory text and its count from one snapshot.
    let memory_query = if table_exists(conn, "session_render_cache")
        && !table_has_column(conn, "session_meta", "cached_m0_bytes")
    {
        "SELECT (SELECT value FROM session_render_cache WHERE session_id = ?1 AND cache_key = 'memory_block_cache'),
                COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1"
    } else {
        "SELECT memory_block_cache, COALESCE(memory_block_count, 0) FROM session_meta WHERE session_id = ?1"
    };
    let (memory_cache_str, memory_count): (Option<String>, i64) = conn
        .query_row(memory_query, [session_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((None, 0));

    let memory_chars = memory_cache_str
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| s.len() as i64)
        .unwrap_or(0);

    // Estimate tokens
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

#[cfg(test)]
fn normalize_hash(content: &str) -> String {
    crate::memory_history::normalized_hash(content)
}

#[cfg(test)]
mod normalize_hash_tests {
    use super::normalize_hash;

    #[test]
    fn memory_hash_uses_the_plugin_whitespace_set() {
        // Expected digests come from the plugin's own code path:
        // createHash("md5").update(s.toLowerCase().replace(/\s+/g, " ").trim()).
        // U+0085 is not JS whitespace, so it stays inside the word.
        assert_eq!(
            normalize_hash("a\u{0085}b"),
            "7337d246dc3bfd7109e19d37193e7f19"
        );
        // U+FEFF is JS whitespace: it collapses and trims away.
        assert_eq!(
            normalize_hash("\u{FEFF}User  Prefers\u{00A0}Bun\u{FEFF}"),
            "c35b4c1bcc1a2fabeb3e9efa7bac6597"
        );
        assert_eq!(
            normalize_hash("x\u{2028}y\u{3000}z\t"),
            "a0971f3c1fc2d4c967b3cd362cc29f48"
        );
    }
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
        "tag_identity_repair" => Some("Tag identity repair"),
        "latest_turn_thinking_removed" => Some("Rejected thinking removed"),
        _ => None,
    }
}

/// Every reason the plugin records when Magic Context rebuilds the prompt
/// (`canonicalReasons` in
/// `packages/plugin/src/features/magic-context/transform-decision-log.ts`).
/// TypeScript passes are normalized to this list before they are written;
/// Rust passes write the module's own reason as-is.
const MAGIC_CONTEXT_REBUILD_REASONS: &[&str] = &[
    "system_hash",
    "model_change",
    "project_memory_epoch",
    "ttl_idle",
    "explicit_flush",
    "user_flush",
    "fit_retry",
    "pending_materialization",
    "variant_change",
    "recomp",
    "boundary_repair",
    "host_history_change",
    "thinking_hold",
    "mutation_drift",
    "max_mutation_id",
    "first_render",
    "pressure_refold",
    "upgrade_state",
    "cached_m1_missing",
    "project_change",
    "compartment_render_epoch",
    "m1_delta",
    "ttl_expiry",
    "epoch_change",
    "coverage_fold",
    "profile_transition",
    "host_compaction",
    "tag_identity_repair",
    "latest_turn_thinking_removed",
];

/// Prefix the plugin writes when the host stops replaying its frozen
/// last-known-good request and serves new bytes instead. The rest of the value
/// names why, and `first_changed=` names the first block that differs.
const LKG_FROZEN_RELEASE_PREFIX: &str = "lkg_frozen_release:";

/// Whether a recorded pass changed what the provider was sent, so that its
/// reason can explain a cache loss on the same request.
///
/// Every Rust-mode pass writes a row, including passes that served the bytes
/// the provider already had: a SOFT+ replay (recorded as `defer` with no
/// reason), a raw pass-through (`passthrough`, reason `pending_rewrite`), or
/// a full-sync request. Those rows explain nothing. A row explains a loss when
/// the pass rebuilt the prompt (`execute`), when it names one of Magic
/// Context's rebuild reasons (a TypeScript pass writes a row only when it
/// changed the prompt, and a `system_hash` row marks a system prompt change
/// whatever the pass served), or when the host released its frozen replay and
/// a block actually changed.
fn transform_decision_changed_prompt(decision: &TransformDecisionCause) -> bool {
    if decision.decision == "execute" {
        return true;
    }
    let Some(reason) = decision.materialize_reason.as_deref() else {
        return false;
    };
    if let Some(release) = reason.strip_prefix(LKG_FROZEN_RELEASE_PREFIX) {
        return !release
            .split(';')
            .any(|field| field == "first_changed=none");
    }
    MAGIC_CONTEXT_REBUILD_REASONS.contains(&reason)
}

fn transform_decision_cause(decision: Option<&TransformDecisionCause>) -> Option<String> {
    let decision = decision?;
    if decision.decision == "error" {
        return Some(MC_TRANSFORM_FAILED_OPEN_CAUSE.to_string());
    }
    if decision.emergency {
        return Some("Compaction pressure".to_string());
    }
    if !transform_decision_changed_prompt(decision) {
        return None;
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

/// A cache loss right after a warm read, on a request whose prompt did not
/// shrink and that Magic Context recorded no change to. The label states that
/// evidence; it does not claim Magic Context could not have been involved.
const PROVIDER_CACHE_MISS_CAUSE: &str = "Provider cache miss (no change recorded by Magic Context)";

const MINUTE_MS: i64 = 60_000;

/// How long a provider keeps a cached prompt prefix after its last use, as the
/// shortest and longest lifetime the evidence allows. A known TTL has both
/// ends equal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CacheLifetime {
    shortest_ms: i64,
    longest_ms: i64,
}

/// Prompt-cache lifetimes stated in provider documentation, used when the
/// session records no TTL of its own. A provider has a row only when its
/// documentation states both the shortest and the longest lifetime; without a
/// row, a session with no recorded TTL gets no provider-side label.
const DOCUMENTED_CACHE_LIFETIMES: &[(&str, CacheLifetime)] = &[(
    // "By default, the cache has a 5-minute lifetime" and the "1-hour cache
    // duration" is the longer option:
    // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
    "anthropic",
    CacheLifetime {
        shortest_ms: 5 * MINUTE_MS,
        longest_ms: 60 * MINUTE_MS,
    },
)];

/// Parse the TTL Magic Context recorded for a session (`session_meta.cache_ttl`)
/// the way the plugin's `parseCacheTtl` does (`scheduler.ts`): `<n>s`, `<n>m`,
/// `<n>h`, or bare milliseconds. `never` means a keep-warm setup that Magic
/// Context does not time, so like an unreadable value it gives no TTL.
fn parse_recorded_cache_ttl_ms(ttl: &str) -> Option<i64> {
    let ttl = ttl.trim();
    let digits_end = ttl.find(|c: char| !c.is_ascii_digit()).unwrap_or(ttl.len());
    let value: i64 = ttl[..digits_end].parse().ok()?;
    let unit_ms = match &ttl[digits_end..] {
        "" => 1,
        "s" => 1_000,
        "m" => MINUTE_MS,
        "h" => 60 * MINUTE_MS,
        _ => return None,
    };
    value.checked_mul(unit_ms).filter(|ms| *ms > 0)
}

/// The cache lifetime a request could rely on: the TTL Magic Context recorded
/// for the session when it is a duration, otherwise the serving provider's
/// documented range, otherwise unknown.
fn cache_lifetime(recorded_ttl: Option<&str>, provider: Option<&str>) -> Option<CacheLifetime> {
    if let Some(ttl_ms) = recorded_ttl.and_then(parse_recorded_cache_ttl_ms) {
        return Some(CacheLifetime {
            shortest_ms: ttl_ms,
            longest_ms: ttl_ms,
        });
    }
    let provider = provider?;
    DOCUMENTED_CACHE_LIFETIMES
        .iter()
        .find(|(name, _)| *name == provider)
        .map(|(_, lifetime)| *lifetime)
}

/// Smallest read shortfall that counts, from the meter rule in
/// `packages/plugin/scripts/analyze-cache-busts.ts` (`epsilon`).
const METER_EPSILON_MIN_TOKENS: i64 = 64;

/// The provider read far less than the previous request's prompt, by the meter
/// rule `analyze-cache-busts.ts` applies: the comparable read is below the
/// previous prompt total minus `max(64, previous uncached input)`. A provider
/// with explicit cache writes (Anthropic) counts the request's uncached input
/// as comparable; an implicit-prefix cache (OpenAI, Gemini) counts only the
/// cached read, because its uncached input includes the rewritten prefix.
fn meter_reports_short_read(
    previous: &DbCacheEvent,
    current: &DbCacheEvent,
    explicit_cache_writes: bool,
) -> bool {
    let comparable_read = if explicit_cache_writes {
        current.cache_read + current.input_tokens
    } else {
        current.cache_read
    };
    comparable_read < meter_floor(previous)
}

/// The previous request's prompt total minus the meter's allowance
/// `max(64, previous uncached input)`.
fn meter_floor(previous: &DbCacheEvent) -> i64 {
    let previous_total = previous.input_tokens + previous.cache_read + previous.cache_write;
    previous_total - METER_EPSILON_MIN_TOKENS.max(previous.input_tokens)
}

/// The request's whole prompt is no smaller than the previous one, within the
/// same allowance the meter uses. A prompt that shrank proves the request
/// itself changed (Magic Context or the host removed something), so its cache
/// loss cannot be put on the provider alone.
fn prompt_did_not_shrink(previous: &DbCacheEvent, current: &DbCacheEvent) -> bool {
    current.input_tokens + current.cache_read + current.cache_write >= meter_floor(previous)
}

/// "N min" below two hours, "H h M min" above, rounded down to the minute.
fn format_idle_gap(gap_ms: i64) -> String {
    let minutes = gap_ms / MINUTE_MS;
    if minutes < 120 {
        return format!("{minutes} min");
    }
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("{hours} h")
    } else {
        format!("{hours} h {rest} min")
    }
}

/// Name a cache loss that happened on the provider's side, for a request whose
/// prompt Magic Context recorded no change to. Callers check recorded Magic
/// Context causes first; this only fills the gap they leave.
///
/// - The gap since the previous request is longer than the longest lifetime:
///   the cache expired while the session sat idle.
/// - The gap is shorter than the shortest lifetime, the previous request read
///   from the cache, this one read far less, and its prompt did not shrink:
///   the provider did not reuse a cache that was still alive. A prompt that
///   shrank changed the request, so it gets no provider-side label.
/// - Between the two, either is possible, so no label is given.
fn provider_side_cause(
    previous: &DbCacheEvent,
    current: &DbCacheEvent,
    lifetime: Option<CacheLifetime>,
    explicit_cache_writes: bool,
) -> Option<String> {
    let lifetime = lifetime?;
    let gap_ms = current.timestamp - previous.timestamp;
    if gap_ms > lifetime.longest_ms {
        return Some(format!(
            "Cache expired after {} idle",
            format_idle_gap(gap_ms)
        ));
    }
    if gap_ms >= 0
        && gap_ms < lifetime.shortest_ms
        && previous.cache_read > 0
        && meter_reports_short_read(previous, current, explicit_cache_writes)
        && prompt_did_not_shrink(previous, current)
    {
        return Some(PROVIDER_CACHE_MISS_CAUSE.to_string());
    }
    None
}

pub fn load_raw_db_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Result<Vec<RawDbCacheEvent>, rusqlite::Error> {
    let mut events = Vec::new();
    let mut seen_sessions: HashSet<String> = HashSet::new();
    for store_events in for_each_opencode_store(&readable_opencode_stores(), |_, conn, sessions| {
        let mut store_events = Vec::new();
        for &generation in &sessions.generations {
            store_events.extend(load_raw_db_cache_events_for_generation(
                conn,
                sessions,
                generation,
                limit,
                since_timestamp,
            )?);
        }
        Ok::<_, rusqlite::Error>((
            store_events,
            sessions.owners.keys().cloned().collect::<Vec<_>>(),
        ))
    }) {
        let (store_events, store_sessions) = store_events?;
        // A session id held by an earlier store (a copied store) is read
        // from that store only, like every other merged reader.
        events.extend(
            store_events
                .into_iter()
                .filter(|event| !seen_sessions.contains(&event.session_id)),
        );
        seen_sessions.extend(store_sessions);
    }
    events.sort_by_key(|event| std::cmp::Reverse(event.timestamp));
    events.truncate(limit.saturating_mul(10));
    Ok(events)
}

fn load_raw_db_cache_events_for_generation(
    conn: &Connection,
    sessions: &OpenCodeSessions,
    generation: OpenCodeStoreGeneration,
    limit: usize,
    since_timestamp: Option<i64>,
) -> Result<Vec<RawDbCacheEvent>, rusqlite::Error> {
    // Per-session windowing: each session gets up to `limit` recent events
    // (so a session-filtered timeline always has full bar coverage), capped
    // globally at `limit * 10` to bound memory across many concurrent sessions.
    // Without this, a 200-event global window split across e.g. 4 active
    // sessions left each session with only ~50 bars on the chart.
    let per_session_limit = limit as i64;
    let global_cap = per_session_limit.saturating_mul(10);

    let (mut sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(since) =
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
                       CAST(json_extract(m.data, '$.parentID') AS TEXT) AS native_turn_id,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
                  AND m.time_created > ?1
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish, native_turn_id
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
                       CAST(json_extract(m.data, '$.parentID') AS TEXT) AS native_turn_id,
                       ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.time_created DESC) AS rn
                FROM message m
                WHERE json_extract(m.data, '$.role') = 'assistant'
                  AND COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0) > 0
            )
            SELECT msg_id, session_id, time_created, input_tokens, cache_read,
                   cache_write, total_tokens, agent, finish, native_turn_id
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

    if generation == OpenCodeStoreGeneration::V1
        && sessions.generations.contains(&OpenCodeStoreGeneration::V2)
    {
        sql = sql.replace(
            "WHERE json_extract(m.data, '$.role') = 'assistant'",
            "WHERE m.session_id NOT IN (SELECT id FROM session_v2) AND json_extract(m.data, '$.role') = 'assistant'",
        );
    }
    let harness = match generation {
        OpenCodeStoreGeneration::V1 => Harness::Opencode,
        OpenCodeStoreGeneration::V2 => {
            const V1_TOTAL: &str =
                "COALESCE(CAST(json_extract(m.data, '$.tokens.total') AS INTEGER), 0)";
            const V2_TOTAL: &str = "(COALESCE(CAST(json_extract(m.data, '$.tokens.input') AS INTEGER), 0) + COALESCE(CAST(json_extract(m.data, '$.tokens.output') AS INTEGER), 0) + COALESCE(CAST(json_extract(m.data, '$.tokens.reasoning') AS INTEGER), 0) + COALESCE(CAST(json_extract(m.data, '$.tokens.cache.read') AS INTEGER), 0) + COALESCE(CAST(json_extract(m.data, '$.tokens.cache.write') AS INTEGER), 0))";
            sql = sql
                .replace("FROM message m", "FROM session_message m")
                .replace(
                    "WHERE json_extract(m.data, '$.role') = 'assistant'",
                    "WHERE m.type = 'assistant'",
                )
                .replace("CAST(json_extract(m.data, '$.parentID') AS TEXT)", "NULL")
                .replace(V1_TOTAL, V2_TOTAL);
            Harness::Opencode2
        }
    };
    let mut stmt = conn.prepare(&sql)?;
    let params_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        Ok(RawDbCacheEvent {
            harness,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
            native_turn_id: row.get(9)?,
            context_limit: None,
            provider: None,
            model: None,

            cache_reported: true,
        })
    })?;

    Ok(rows
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|event| sessions.owns(&event.session_id, generation))
        .collect())
}

/// Load Pi-compatible cache events from JSONL session files. Each native
/// session root keeps its own harness identity while sharing the parser.
pub fn load_raw_pi_cache_events(
    limit: usize,
    since_timestamp: Option<i64>,
) -> Vec<RawDbCacheEvent> {
    let mut all_rows = load_raw_pi_compatible_cache_events(
        Harness::Pi,
        pi_sessions::scan_pi_session_dir(),
        limit,
        since_timestamp,
    );
    all_rows.extend(load_raw_pi_compatible_cache_events(
        Harness::Omp,
        pi_sessions::scan_omp_session_dir(),
        limit,
        since_timestamp,
    ));
    all_rows.sort_by_key(|row| std::cmp::Reverse(row.timestamp));
    all_rows.truncate(limit.saturating_mul(10));
    all_rows
}

/// Pi-compatible assistant messages carry the serving `provider` and `model`
/// on the message object inside the JSONL entry.
fn pi_message_provider_model(entry: &serde_json::Value) -> (Option<String>, Option<String>) {
    let field = |key: &str| {
        entry["message"][key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    (field("provider"), field("model"))
}

fn load_raw_pi_compatible_cache_events(
    harness: Harness,
    sessions: Vec<pi_sessions::PiSessionMeta>,
    limit: usize,
    since_timestamp: Option<i64>,
) -> Vec<RawDbCacheEvent> {
    let mut all_rows = Vec::new();
    for meta in sessions {
        let Some(detail) = pi_sessions::read_pi_session_detail(&meta.jsonl_path) else {
            continue;
        };
        let mut session_rows: Vec<RawDbCacheEvent> = detail
            .messages
            .iter()
            .filter(|message| message.role == "assistant")
            .filter_map(|message| {
                let usage = message.usage.as_ref()?;
                if usage.total == 0
                    || since_timestamp.is_some_and(|since| message.timestamp_ms <= since)
                {
                    return None;
                }
                let (provider, model) = pi_message_provider_model(&message.raw_json);
                Some(RawDbCacheEvent {
                    harness,
                    message_id: message.entry_id.clone(),
                    session_id: meta.session_id.clone(),
                    timestamp: message.timestamp_ms,
                    input_tokens: usage.input as i64,
                    cache_read: usage.cache_read as i64,
                    cache_write: usage.cache_write as i64,
                    total_tokens: usage.total as i64,
                    agent: None,
                    finish: message.stop_reason.clone(),
                    native_turn_id: None,
                    context_limit: None,
                    provider,
                    model,

                    cache_reported: true,
                })
            })
            .collect();
        session_rows.sort_by_key(|row| std::cmp::Reverse(row.timestamp));
        session_rows.truncate(limit);
        all_rows.extend(session_rows);
    }
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
                    native_turn_id: None,
                    context_limit: event.context_limit,
                    provider: harness.jsonl_provider().map(str::to_owned),
                    model: event.model.clone(),

                    cache_reported: true,
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
    if keys.is_empty() {
        return HashMap::new();
    }
    let Some(db_path) = resolve_db_path() else {
        return HashMap::new();
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return HashMap::new();
    };
    resolve_session_context_limits_from_conn(&conn, keys)
}

fn resolve_session_context_limits_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), i64> {
    let mut out: HashMap<(Harness, String), i64> = HashMap::new();
    if keys.is_empty() {
        return out;
    }
    // Only the wanted sessions, by primary key: session_meta rows are wide
    // (cached prompt blobs sit before this column), so filtering the whole
    // table read every row of a busy store (35 MB) on each events fetch.
    let wanted: Vec<&str> = keys.iter().map(|(_, id)| id.as_str()).collect();
    let Ok(wanted) = serde_json::to_string(&wanted) else {
        return out;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, harness, COALESCE(last_usage_context_limit, 0)
         FROM session_meta
         WHERE session_id IN (SELECT value FROM json_each(?1))
           AND COALESCE(last_usage_context_limit, 0) > 0",
    ) else {
        return out;
    };
    let rows = stmt.query_map([wanted], |row| {
        let sid: String = row.get(0)?;
        let harness_str: String = row.get(1)?;
        let limit: i64 = row.get(2)?;
        Ok((sid, harness_str, limit))
    });
    // Index by session id: a strict (harness, id) match misses converted
    // OpenCode sessions whose timeline label (`opencode2`) differs from the
    // label the plugin recorded (`opencode`), which is what drops those
    // sessions onto the auto-scale fallback.
    let mut by_session_id: HashMap<String, Vec<(Harness, i64)>> = HashMap::new();
    if let Ok(rows) = rows {
        for r in rows.flatten() {
            let Ok(harness) = r.1.parse::<Harness>() else {
                continue;
            };
            by_session_id.entry(r.0).or_default().push((harness, r.2));
        }
    }
    for (harness, session_id) in keys {
        let Some(candidates) = by_session_id.get(session_id) else {
            continue;
        };
        // An exact harness label wins when two rows ever share the id;
        // otherwise a row from the same session-id family (OpenCode 1/2)
        // applies. Ids from other families have different shapes and are
        // never aliased.
        let limit = candidates
            .iter()
            .find(|(h, _)| h == harness)
            .or_else(|| {
                candidates
                    .iter()
                    .find(|(h, _)| harness.shares_session_ids_with(*h))
            })
            .map(|(_, limit)| *limit);
        if let Some(limit) = limit {
            out.insert((*harness, session_id.clone()), limit);
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
    // Index by session id so a converted OpenCode session whose timeline
    // label (`opencode2`) differs from the recorded label (`opencode`) still
    // sees its decisions; see resolve_session_context_limits_from_conn.
    let mut by_session_id: HashMap<String, Vec<(Harness, String, TransformDecisionCause)>> =
        HashMap::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let Ok(harness) = row.1.parse::<Harness>() else {
                continue;
            };
            by_session_id
                .entry(row.0)
                .or_default()
                .push((harness, row.2, row.3));
        }
    }
    for (req_harness, session_id) in keys {
        let Some(rows) = by_session_id.get(session_id) else {
            continue;
        };
        // Exact-label rows win when the id was recorded under both labels.
        let has_exact = rows.iter().any(|(h, _, _)| h == req_harness);
        for (harness, message_id, cause) in rows {
            let applies = if has_exact {
                harness == req_harness
            } else {
                req_harness.shares_session_ids_with(*harness)
            };
            if applies {
                out.insert(
                    (*req_harness, session_id.clone(), message_id.clone()),
                    cause.clone(),
                );
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
    // Index by session id so a converted OpenCode session whose timeline
    // label (`opencode2`) differs from the recorded label (`opencode`) still
    // sees its failure flag; see resolve_session_context_limits_from_conn.
    let mut by_session_id: HashMap<String, Vec<Harness>> = HashMap::new();
    if let Ok(rows) = rows {
        for row in rows.flatten() {
            let Ok(harness) = row.1.parse::<Harness>() else {
                continue;
            };
            by_session_id.entry(row.0).or_default().push(harness);
        }
    }
    for (req_harness, session_id) in keys {
        let Some(labels) = by_session_id.get(session_id) else {
            continue;
        };
        // An exact harness label wins; otherwise a label from the same
        // session-id family (OpenCode 1/2) applies.
        let applies = labels.iter().any(|h| h == req_harness)
            || labels
                .iter()
                .any(|h| req_harness.shares_session_ids_with(*h));
        if applies {
            out.insert((*req_harness, session_id.clone()));
        }
    }
    out
}

/// The TTL Magic Context recorded for each session (`session_meta.cache_ttl`),
/// as written: `5m`, `1h`, `never`, ...
fn load_session_cache_ttls(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), String> {
    if keys.is_empty() {
        return HashMap::new();
    }
    let Some(db_path) = resolve_db_path() else {
        return HashMap::new();
    };
    let Ok(conn) = open_readonly(&db_path) else {
        return HashMap::new();
    };
    load_session_cache_ttls_from_conn(&conn, keys)
}

fn load_session_cache_ttls_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), String> {
    let mut out = HashMap::new();
    let session_ids: HashSet<String> = keys.iter().map(|(_, sid)| sid.clone()).collect();
    if session_ids.is_empty() {
        return out;
    }
    let placeholders = vec!["?"; session_ids.len()].join(",");
    let sql = format!(
        "SELECT session_id, harness, cache_ttl
         FROM session_meta
         WHERE session_id IN ({})",
        placeholders
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return out;
    };
    let rows = stmt.query_map(params_from_iter(session_ids.iter()), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    });
    // Index by session id so a converted OpenCode session whose timeline
    // label (`opencode2`) differs from the recorded label (`opencode`) still
    // sees its TTL; see resolve_session_context_limits_from_conn.
    let mut by_session_id: HashMap<String, Vec<(Harness, String)>> = HashMap::new();
    if let Ok(rows) = rows {
        for (session_id, harness, ttl) in rows.flatten() {
            let (Ok(harness), Some(ttl)) = (harness.parse::<Harness>(), ttl) else {
                continue;
            };
            by_session_id
                .entry(session_id)
                .or_default()
                .push((harness, ttl));
        }
    }
    for (req_harness, session_id) in keys {
        let Some(rows) = by_session_id.get(session_id) else {
            continue;
        };
        let ttl = rows
            .iter()
            .find(|(harness, _)| harness == req_harness)
            .or_else(|| {
                rows.iter()
                    .find(|(harness, _)| req_harness.shares_session_ids_with(*harness))
            });
        if let Some((_, ttl)) = ttl {
            out.insert((*req_harness, session_id.clone()), ttl.clone());
        }
    }
    out
}

fn finish_continues_turn(finish: &str) -> bool {
    matches!(finish, "tool-calls" | "toolUse" | "tool_use")
}

fn build_db_cache_events(rows: Vec<RawDbCacheEvent>, enrich_causes: bool) -> Vec<DbCacheEvent> {
    build_db_cache_events_with_overrides(rows, enrich_causes, None, None, None, None)
}

#[cfg(test)]
fn build_db_cache_events_with_decisions(
    rows: Vec<RawDbCacheEvent>,
    enrich_causes: bool,
    transform_decisions_override: Option<
        HashMap<(Harness, String, String), TransformDecisionCause>,
    >,
) -> Vec<DbCacheEvent> {
    build_db_cache_events_with_attribution(
        rows,
        enrich_causes,
        transform_decisions_override,
        None,
        Some(HashMap::new()),
    )
}

#[cfg(test)]
fn build_db_cache_events_with_attribution(
    rows: Vec<RawDbCacheEvent>,
    enrich_causes: bool,
    transform_decisions_override: Option<
        HashMap<(Harness, String, String), TransformDecisionCause>,
    >,
    transform_failure_sessions_override: Option<HashSet<(Harness, String)>>,
    session_cache_ttls_override: Option<HashMap<(Harness, String), String>>,
) -> Vec<DbCacheEvent> {
    build_db_cache_events_with_overrides(
        rows,
        enrich_causes,
        transform_decisions_override,
        transform_failure_sessions_override,
        session_cache_ttls_override,
        None,
    )
}

/// Each `*_override` replaces what would otherwise be read from the stores on
/// disk, so tests can supply it; `None` reads the store.
fn build_db_cache_events_with_overrides(
    rows: Vec<RawDbCacheEvent>,
    enrich_causes: bool,
    transform_decisions_override: Option<
        HashMap<(Harness, String, String), TransformDecisionCause>,
    >,
    transform_failure_sessions_override: Option<HashSet<(Harness, String)>>,
    session_cache_ttls_override: Option<HashMap<(Harness, String), String>>,
    mc_state_sessions_override: Option<HashSet<(Harness, String)>>,
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
        .filter(|((h, _), _)| matches!(h, Harness::Opencode | Harness::Opencode2))
        .map(|((_, sid), _)| sid.clone())
        .collect();
    if !oc_session_ids.is_empty() {
        let mut claimed: HashSet<String> = HashSet::new();
        for found in for_each_opencode_store(&readable_opencode_stores(), |_, conn, resolved| {
            let mut found: Vec<(Harness, String, Option<i64>)> = Vec::new();
            for &generation in &resolved.generations {
                let first_event_sql = match generation {
                    OpenCodeStoreGeneration::V1 => FIRST_OPENCODE_CACHE_EVENT_SQL,
                    OpenCodeStoreGeneration::V2 => FIRST_OPENCODE2_CACHE_EVENT_SQL,
                };
                let harness = opencode_generation_harness(generation);
                if let Ok(mut stmt) = conn.prepare(first_event_sql) {
                    for sid in &oc_session_ids {
                        if !resolved.owns(sid, generation) {
                            continue;
                        }
                        let db_earliest = stmt
                            .query_row(params![&sid], |row| row.get::<_, i64>(0))
                            .optional()
                            .ok()
                            .flatten();
                        found.push((harness, sid.clone(), db_earliest));
                    }
                }
            }
            found
        }) {
            // The store listed first answers for a session id it holds.
            let mut store_claims = Vec::new();
            for (harness, sid, db_earliest) in found {
                if claimed.contains(&sid) {
                    continue;
                }
                store_claims.push(sid.clone());
                let window_earliest = earliest_ts_in_window.get(&(harness, sid.clone()));
                if db_earliest
                    .zip(window_earliest)
                    .is_some_and(|(db, window)| *window <= db)
                {
                    true_first_sessions.insert((harness, sid));
                }
            }
            claimed.extend(store_claims);
        }
    }

    // Pi and OMP use the same JSONL shape but remain separate cache lanes.
    let mut pi_true_first: HashSet<(Harness, String)> = HashSet::new();
    let pi_sessions_in_window: Vec<(Harness, String)> = earliest_ts_in_window
        .iter()
        .filter(|((h, _), _)| matches!(h, Harness::Pi | Harness::Omp))
        .map(|((harness, sid), _)| (*harness, sid.clone()))
        .collect();
    if !pi_sessions_in_window.is_empty() {
        let pi_meta_by_id: HashMap<(Harness, String), std::path::PathBuf> =
            pi_sessions::scan_pi_session_dir()
                .into_iter()
                .map(|meta| ((Harness::Pi, meta.session_id), meta.jsonl_path))
                .chain(
                    pi_sessions::scan_omp_session_dir()
                        .into_iter()
                        .map(|meta| ((Harness::Omp, meta.session_id), meta.jsonl_path)),
                )
                .collect();
        for (harness, sid) in pi_sessions_in_window {
            let key = (harness, sid.clone());
            let Some(path) = pi_meta_by_id.get(&key) else {
                continue;
            };
            let Some(detail) = pi_sessions::read_pi_session_detail(path) else {
                continue;
            };
            let db_earliest = detail
                .messages
                .iter()
                .filter(|message| {
                    message.role == "assistant"
                        && message.usage.as_ref().is_some_and(|usage| usage.total > 0)
                })
                .map(|message| message.timestamp_ms)
                .min();
            if let (Some(db_earliest), Some(window_earliest)) =
                (db_earliest, earliest_ts_in_window.get(&key))
            {
                if *window_earliest <= db_earliest {
                    pi_true_first.insert(key);
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
            cache_reported: row.cache_reported,
            total_tokens: row.total_tokens,
            hit_ratio,
            severity: String::new(),
            cause: None,
            agent: row.agent,
            finish: row.finish,
            native_turn_id: row.native_turn_id,
            turn_id: String::new(),
            is_turn_start: false,
            context_limit: row.context_limit.unwrap_or(0),
            context_limit_estimated: false, // set with context_limit below
            is_drop: false,                 // computed in pass 2
            context_reduced_by_mc: false,   // set per session in pass 2

            cold_start: false,

            provider: row.provider,
            model: row.model,
        });
    }

    // Inputs may arrive in any order; sort ascending so "previous" really means
    // "earlier in time" before computing turn IDs and cross-step retention.
    chronological.sort_by_key(|e| e.timestamp);

    // A session where NO row reports a positive cache_read doesn't expose cache
    // accounting at all (e.g. ollama-cloud reports cache_read=0 everywhere). We
    // can't judge its cache health, so every row is UNKNOWN, never a false bust.
    let mut session_has_cache: HashMap<(Harness, String), bool> = HashMap::new();
    // Providers with an explicit cache (Anthropic) report cache writes; an
    // implicit-prefix cache (OpenAI, Gemini) never does. The meter rule for a
    // provider-side miss counts uncached input differently for the two.
    let mut session_reports_cache_writes: HashSet<(Harness, String)> = HashSet::new();
    for e in &chronological {
        let entry = session_has_cache
            .entry((e.harness, e.session_id.clone()))
            .or_insert(false);
        if e.cache_read > 0 {
            *entry = true;
        }
        if e.cache_write > 0 {
            session_reports_cache_writes.insert((e.harness, e.session_id.clone()));
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
    let session_cache_ttls = session_cache_ttls_override.unwrap_or_else(|| {
        if enrich_causes {
            load_session_cache_ttls(&session_keys)
        } else {
            HashMap::new()
        }
    });
    // Read whether or not causes are enriched: the drop label depends on it,
    // and the Claude Code, Codex and Broca timelines never enrich causes.
    let mc_state_sessions =
        mc_state_sessions_override.unwrap_or_else(|| load_mc_state_sessions(&session_keys));

    // ── Pass 2: turn grouping + cross-step retention severity ──
    // Expected next cache_read = prev.cache_read + growth, where growth is the
    // freshly-cacheable content the previous step contributed:
    //   - Anthropic reports it directly as cache_write (cache_creation tokens).
    //   - When cache_write is absent, use only the previous uncached input.
    //     Generated output (including reasoning) is not automatically part of
    //     the next step's cached input: the host may not resend those bytes.
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

        // OpenCode persists the native user→assistant relationship as `parentID`.
        // It is authoritative even when an interrupted tool step is followed by a
        // queued user message. JSONL harnesses lack that key, so they fall back to
        // their provider-specific tool-continuation finish values.
        let native_turn_id = chronological[i]
            .native_turn_id
            .as_deref()
            .filter(|turn_id| !turn_id.is_empty());
        let prev_finish = last_finish_by_session.get(&session_key).cloned();
        let inferred_is_new_turn = prev_finish
            .as_deref()
            .map_or(true, |finish| !finish_continues_turn(finish));
        let turn_id = native_turn_id.map(ToString::to_string).unwrap_or_else(|| {
            if inferred_is_new_turn {
                chronological[i].message_id.clone()
            } else {
                current_turn_id_by_session
                    .get(&session_key)
                    .cloned()
                    .unwrap_or_else(|| chronological[i].message_id.clone())
            }
        });
        let is_new_turn = current_turn_id_by_session.get(&session_key) != Some(&turn_id);
        chronological[i].is_turn_start = is_new_turn;
        chronological[i].turn_id = turn_id.clone();
        current_turn_id_by_session.insert(session_key.clone(), turn_id);

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
        let context_reduced_by_mc = session_context_reduced_by_mc(
            chronological[i].harness,
            &cur_session,
            &mc_state_sessions,
        );
        chronological[i].context_reduced_by_mc = context_reduced_by_mc;
        // A Magic Context decision explains only a session whose context Magic
        // Context manages; in any other session it must not become the cause.
        let decision_row = transform_decisions
            .get(&decision_key)
            .filter(|_| context_reduced_by_mc);
        let has_transform_failure = transform_failure_sessions.contains(&session_key);
        // A missing decision is normal for routine passes that do not invalidate
        // the cache: the plugin persists decisions only when they bust the cache.
        // Order of attribution for a bust:
        //   1. the cause Magic Context recorded for this request's pass (a pass
        //      that changed nothing records none, see
        //      transform_decision_changed_prompt);
        //   2. a transform error Magic Context recorded for the session;
        //   3. a provider-side loss the timing and usage show (idle expiry, or a
        //      miss right after a warm read), see provider_side_cause;
        //   4. otherwise the origin is unknown.
        // So an expired cache on a request Magic Context also folded is still
        // labelled with the fold.
        let cause_from_decision = || transform_decision_cause(decision_row);
        let cause_from_bust = |provider_side: Option<String>| {
            cause_from_decision()
                .or_else(|| {
                    has_transform_failure.then(|| MC_TRANSFORM_FAILED_OPEN_CAUSE.to_string())
                })
                .or(provider_side)
                .or_else(|| Some(UNATTRIBUTED_CACHE_BUST_CAUSE.to_string()))
        };
        let lifetime = cache_lifetime(
            session_cache_ttls.get(&session_key).map(String::as_str),
            chronological[i].provider.as_deref(),
        );
        let explicit_cache_writes = session_reports_cache_writes.contains(&session_key);

        let (severity, cause, retention): (String, Option<String>, Option<f64>) =
            if !chronological[i].cache_reported || no_cache_session {
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
                let (prev_read, prev_write, prev_input) = {
                    let prev = &chronological[prev_idx];
                    (prev.cache_read, prev.cache_write, prev.input_tokens)
                };
                if prev_read == 0 {
                    // No cache was established on the prior step (cold / still
                    // warming up), so a low/zero cache_read now isn't a LOSS.
                    ("stable".to_string(), None, None)
                } else {
                    let growth = if prev_write > 0 {
                        prev_write
                    } else {
                        prev_input
                    };
                    let expected = prev_read + growth; // > 0 since prev_read > 0
                    let provider_side = || {
                        provider_side_cause(
                            &chronological[prev_idx],
                            &chronological[i],
                            lifetime,
                            explicit_cache_writes,
                        )
                    };
                    if cur_read == 0 {
                        (
                            "full_bust".to_string(),
                            if enrich_causes {
                                cause_from_bust(provider_side())
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
                                    cause_from_bust(provider_side())
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

        // Drop detection: a meaningful prompt shrink vs the previous step. In a
        // session Magic Context manages that is its reclaim, so (if not already)
        // attach the DB-recorded transform decision to explain WHY it dropped.
        // Elsewhere no decision is consulted.
        let mut is_drop = false;
        let mut cause = cause;
        if let Some(&prev_idx) = prev_event_idx_by_session.get(&session_key) {
            let prev = &chronological[prev_idx];
            let prev_prompt = prev.input_tokens + prev.cache_read + prev.cache_write;
            let cur_prompt = chronological[i].input_tokens
                + chronological[i].cache_read
                + chronological[i].cache_write;
            if prev_prompt - cur_prompt >= DROP_MARKER_MIN_TOKENS {
                is_drop = true;
                if cause.is_none() && enrich_causes && context_reduced_by_mc {
                    cause = cause_from_decision();
                }
            }
        }

        chronological[i].severity = severity;
        chronological[i].cause = cause;
        chronological[i].is_drop = is_drop;
        if chronological[i].severity == "info" {
            chronological[i].cold_start = true;
        }
        if let Some(ret) = retention {
            // Display the cross-step RETENTION (cache held vs expected), not the
            // single-row prompt-composition ratio, so bars/percentages reflect
            // actual cache health.
            chronological[i].hit_ratio = ret;
        }

        if chronological[i].cache_reported {
            prev_event_idx_by_session.insert(session_key.clone(), i);
        }
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

#[derive(Debug, Clone)]
struct CacheSessionListEntry {
    harness: Harness,
    session_id: String,
    last_activity_ms: i64,
    title: Option<String>,
}

/// The (device, inode) pair naming the file behind `metadata`, so a reader can
/// tell a file replaced at the same path from the one it already read. `None`
/// where the platform does not expose it; callers then rely on length alone.
pub(crate) fn file_identity(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

/// Broca's state root: `$BROCA_STATE_ROOT` when set, else the first default
/// location that holds a run index.
fn broca_state_root() -> Option<PathBuf> {
    let root = std::env::var_os("BROCA_STATE_ROOT")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(root) = root {
        return root.join("run-index.db").is_file().then_some(root);
    }
    let home = dirs::home_dir()?;
    [
        home.join(".local/share/cortexkit/broca"),
        home.join(".local/share/cortexkit/run/broca-state"),
    ]
    .into_iter()
    .find(|root| root.join("run-index.db").is_file())
}

fn open_broca_store(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        format!("{}?mode=ro", opencode_stores::sqlite_file_uri(path)),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )?;
    conn.set_db_config(
        rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
        true,
    )?;
    conn.busy_timeout(std::time::Duration::from_millis(50))?;
    // Any sort that remains stays in memory instead of a temporary file.
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(conn)
}

mod broca_run_index;

/// A `BrocaRunIndex` with the store path and file identity it was built from.
type CachedBrocaRunIndex = (PathBuf, Option<(u64, u64)>, broca_run_index::BrocaRunIndex);

/// The process-wide `BrocaRunIndex`.
static BROCA_RUN_INDEX: OnceLock<Mutex<Option<CachedBrocaRunIndex>>> = OnceLock::new();

/// Refreshes the shared run index from `conn` (the store at `path`) and runs
/// `f` on it. A replaced store file starts a fresh index.
fn with_broca_run_index<T>(
    conn: &Connection,
    path: &Path,
    f: impl FnOnce(&mut broca_run_index::BrocaRunIndex) -> T,
) -> Option<T> {
    let file_key = std::fs::metadata(path)
        .ok()
        .as_ref()
        .and_then(file_identity);
    let mut guard = BROCA_RUN_INDEX
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()?;
    if !guard
        .as_ref()
        .is_some_and(|(cached, key, _)| cached == path && *key == file_key)
    {
        *guard = Some((path.to_path_buf(), file_key, Default::default()));
    }
    let (_, _, index) = guard.as_mut()?;
    if index.refresh(conn).is_err() {
        // Leave nothing half-read behind for the next poll to build on.
        *guard = None;
        return None;
    }
    Some(f(index))
}

fn load_broca_cache_sessions(limit: usize) -> Vec<CacheSessionListEntry> {
    let Some(root) = broca_state_root() else {
        return Vec::new();
    };
    let path = root.join("run-index.db");
    let Ok(conn) = open_broca_store(&path) else {
        return Vec::new();
    };
    with_broca_run_index(&conn, &path, |index| index.list(limit))
        .map(|listed| broca_list_entries(listed, limit))
        .unwrap_or_default()
}

// Broca exports finished work only. Keep all session identities, including
// folderless sessions; neither a name nor an agent id determines membership.
// Production retains the export cursor across polls, while this test helper
// builds a fresh index.
#[cfg(test)]
fn load_broca_cache_sessions_from_conn(
    conn: &Connection,
    limit: usize,
) -> rusqlite::Result<Vec<CacheSessionListEntry>> {
    let mut index = broca_run_index::BrocaRunIndex::default();
    index.refresh(conn)?;
    Ok(broca_list_entries(index.list(limit), limit))
}

fn broca_list_entries(
    listed: Vec<broca_run_index::ListedSession>,
    limit: usize,
) -> Vec<CacheSessionListEntry> {
    let mut sessions = Vec::new();
    for listed in listed {
        let session_id = listed.identity;
        // Keep undated sessions last without inventing an epoch timestamp.
        // Their nullable activity is carried separately in the export summary.
        let activity = listed
            .activity
            .and_then(|time| i64::try_from(time).ok())
            .unwrap_or(i64::MIN);
        let title = serde_json::from_str::<serde_json::Value>(&session_id)
            .ok()
            .and_then(|identity| identity["session"].as_str().map(str::to_owned));
        sessions.push(CacheSessionListEntry {
            harness: Harness::Broca,
            title,
            session_id,
            last_activity_ms: activity,
        });
    }
    sessions.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    sessions.truncate(limit);
    sessions
}

/// How the Cache tab list dates an OpenCode session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpenCodeCacheActivity {
    /// The session row's own `time_updated`. Right for OpenCode 1, whose host
    /// bumps it on every message write.
    SessionRow,
    /// The later of `session_v2.time_updated` and the session's newest
    /// message row's `time_updated`. OpenCode 2 sets `session_v2.time_updated`
    /// when a prompt is sent and leaves it there for the whole turn, while the
    /// newest `session_message` row (highest `seq`) is rewritten as each step
    /// streams in. Keying on the session row alone froze the Cache tab until
    /// the next prompt.
    NewestMessage,
}

/// Shown on the Cache tab when an OpenCode 2 store's `session_message` table
/// has no `time_updated` column, so the list falls back to the session row's
/// time and cannot see a turn in progress.
const OPENCODE2_ACTIVITY_FALLBACK_NOTE: &str = "This OpenCode 2 database's session_message table has no time_updated column, so OpenCode 2 sessions refresh here only when a new prompt starts, not while a turn is running.";

fn opencode_cache_activity(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
) -> OpenCodeCacheActivity {
    if generation == OpenCodeStoreGeneration::V1 {
        return OpenCodeCacheActivity::SessionRow;
    }
    // Every OpenCode 2 release from 2.0.3 on creates the column, but a store
    // this reader does not recognise must still list its sessions rather than
    // fail the prepare, which would empty the tab.
    let has_message_time_updated = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('session_message') WHERE name = 'time_updated')",
            [],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if has_message_time_updated {
        OpenCodeCacheActivity::NewestMessage
    } else {
        OpenCodeCacheActivity::SessionRow
    }
}

fn recent_opencode_cache_sessions_sql(
    generation: OpenCodeStoreGeneration,
    activity: OpenCodeCacheActivity,
) -> String {
    let table = opencode_session_table(generation);
    match activity {
        OpenCodeCacheActivity::SessionRow => format!(
            "SELECT id, time_updated, NULLIF(title, '')
     FROM {table}
     WHERE time_archived IS NULL
     ORDER BY time_updated DESC, id DESC
     LIMIT ?1 OFFSET ?2"
        ),
        // One seek on the (session_id, seq) unique index per unarchived
        // session, never a scan or GROUP BY over every message row: this runs
        // on every one-second Cache tab poll. The session row's own time stays
        // in the MAX so a session with no messages yet still has a time.
        OpenCodeCacheActivity::NewestMessage => format!(
            "SELECT s.id,
            MAX(s.time_updated, COALESCE((
                SELECT m.time_updated FROM session_message m
                WHERE m.session_id = s.id
                ORDER BY m.seq DESC
                LIMIT 1
            ), 0)) AS activity,
            NULLIF(s.title, '')
     FROM {table} s
     WHERE s.time_archived IS NULL
     ORDER BY activity DESC, s.id DESC
     LIMIT ?1 OFFSET ?2"
        ),
    }
}

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

const RECENT_OPENCODE2_SESSION_MESSAGES_SQL: &str = "SELECT data
     FROM session_message
     WHERE session_id = ?1
     ORDER BY seq DESC
     LIMIT ?2";

const FIRST_OPENCODE2_CACHE_EVENT_SQL: &str = "SELECT time_created
     FROM session_message
     WHERE session_id = ?1 AND type = 'assistant'
       AND json_extract(data, '$.tokens') IS NOT NULL
     ORDER BY seq ASC
     LIMIT 1";

type OpenCodeCachePresenceCache = HashMap<String, (i64, bool)>;

mod opencode_list_cache;

type OpenCodeListCacheSlot = Arc<Mutex<Option<opencode_list_cache::OpenCodeListCache>>>;

/// One list cache per store, keyed by the store's path.
static OPENCODE_LIST_CACHES: OnceLock<Mutex<HashMap<PathBuf, OpenCodeListCacheSlot>>> =
    OnceLock::new();

/// Runs `f` on the process-wide list cache of every readable OpenCode store,
/// (re)opening a cache when its store's file changed, and returns the
/// results in store-list order. Caches of stores no longer listed are
/// dropped. With more than one store, each runs on its own thread, so a large
/// second store delays the poll by its own read time instead of adding to
/// the first store's.
fn with_opencode_list_caches<T: Send>(
    f: impl Fn(&ReadableStore, &mut opencode_list_cache::OpenCodeListCache) -> T + Sync,
) -> Vec<T> {
    let stores = readable_opencode_stores();
    let slots: Vec<(ReadableStore, OpenCodeListCacheSlot)> = {
        let Ok(mut caches) = OPENCODE_LIST_CACHES
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        else {
            return Vec::new();
        };
        caches.retain(|path, _| stores.iter().any(|store| &store.path == path));
        stores
            .into_iter()
            .map(|store| {
                let slot = caches.entry(store.path.clone()).or_default().clone();
                (store, slot)
            })
            .collect()
    };
    let run = |(store, slot): &(ReadableStore, OpenCodeListCacheSlot)| -> Option<T> {
        let mut guard = slot.lock().ok()?;
        if !guard
            .as_ref()
            .is_some_and(|cache| cache.serves(&store.path))
        {
            *guard = None;
            *guard = Some(opencode_list_cache::OpenCodeListCache::open(&store.path).ok()?);
        }
        let cache = guard.as_mut()?;
        let value = f(store, cache);
        if cache.finish_poll() {
            Some(value)
        } else {
            // An immutable store changed under this poll: drop what it read.
            *guard = None;
            None
        }
    };
    if slots.len() <= 1 {
        return slots.iter().filter_map(run).collect();
    }
    std::thread::scope(|scope| {
        let handles: Vec<_> = slots
            .iter()
            .map(|slot| scope.spawn(move || run(slot)))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok().flatten())
            .collect()
    })
}

/// The recent OpenCode sessions for the Cache tab, merged across stores,
/// plus a note to show when OpenCode 2 sessions can only be dated by their
/// session row (see `OPENCODE2_ACTIVITY_FALLBACK_NOTE`). Served from each
/// store's `OpenCodeListCache`, which reads only what changed since the
/// previous poll. A session id found in two stores (a copied store) is
/// listed once, from the store listed first. Only rows of a harness `include`
/// accepts are kept, before the merged list is cut to `limit`: one store's
/// newer sessions of another harness must not push the wanted ones out.
fn load_recent_opencode_cache_sessions(
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
    include: impl Fn(Harness) -> bool,
) -> (Vec<CacheSessionListEntry>, Option<&'static str>) {
    let per_store = with_opencode_list_caches(|_, cache| {
        cache.recent_sessions(limit, hidden_subagent_ids, std::time::Instant::now())
    });
    merge_opencode_cache_lists(per_store, limit, include)
}

fn merge_opencode_cache_lists(
    per_store: Vec<(Vec<CacheSessionListEntry>, Option<&'static str>)>,
    limit: usize,
    include: impl Fn(Harness) -> bool,
) -> (Vec<CacheSessionListEntry>, Option<&'static str>) {
    let mut seen = HashSet::new();
    let mut sessions = Vec::new();
    let mut note = None;
    for (rows, store_note) in per_store {
        note = note.or(store_note);
        sessions.extend(
            rows.into_iter()
                .filter(|row| include(row.harness) && seen.insert(row.session_id.clone())),
        );
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_activity_ms));
    sessions.truncate(limit);
    (sessions, note)
}

/// The same list from one connection with nothing kept between calls: the
/// reference `OpenCodeListCache` must agree with.
#[cfg(test)]
fn load_recent_opencode_cache_sessions_uncached(
    conn: &Connection,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
) -> (Vec<CacheSessionListEntry>, Option<&'static str>) {
    let Ok(resolved) = resolve_opencode_sessions(conn) else {
        return (Vec::new(), None);
    };
    let note = resolved
        .generations
        .iter()
        .find_map(|&generation| opencode_cache_activity_note(conn, generation));
    let mut sessions = Vec::new();
    for &generation in &resolved.generations {
        let rows = load_recent_opencode_cache_sessions_from_conn(
            conn,
            generation,
            limit,
            hidden_subagent_ids,
        );
        sessions.extend(
            rows.into_iter()
                .filter(|row| resolved.owns(&row.session_id, generation)),
        );
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.last_activity_ms));
    sessions.truncate(limit);
    (sessions, note)
}

fn opencode_cache_activity_note(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
) -> Option<&'static str> {
    (generation == OpenCodeStoreGeneration::V2
        && opencode_cache_activity(conn, generation) == OpenCodeCacheActivity::SessionRow)
        .then_some(OPENCODE2_ACTIVITY_FALLBACK_NOTE)
}

#[cfg(test)]
fn load_recent_opencode_cache_sessions_from_conn(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
) -> Vec<CacheSessionListEntry> {
    load_recent_opencode_cache_sessions_with_cache(
        conn,
        generation,
        limit,
        hidden_subagent_ids,
        &mut HashMap::new(),
    )
}

fn load_recent_opencode_cache_sessions_with_cache(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
    presence_cache: &mut OpenCodeCachePresenceCache,
) -> Vec<CacheSessionListEntry> {
    if limit == 0 {
        return Vec::new();
    }
    let activity = opencode_cache_activity(conn, generation);
    let mut candidate_sql = recent_opencode_cache_sessions_sql(generation, activity);
    if generation == OpenCodeStoreGeneration::V1
        && table_exists(conn, "session_v2")
        && table_exists(conn, "session_message")
    {
        candidate_sql = candidate_sql
            .replace(
                "WHERE time_archived IS NULL",
                "WHERE time_archived IS NULL AND id NOT IN (SELECT id FROM session_v2)",
            )
            .replace(
                "WHERE s.time_archived IS NULL",
                "WHERE s.time_archived IS NULL AND s.id NOT IN (SELECT id FROM session_v2)",
            );
    }
    let Ok(mut candidates_stmt) = conn.prepare(&candidate_sql) else {
        return Vec::new();
    };
    let harness = opencode_generation_harness(generation);
    filter_opencode_cache_candidates(
        conn,
        generation,
        limit,
        hidden_subagent_ids,
        presence_cache,
        |page_limit, offset| {
            let rows = candidates_stmt
                .query_map(params![page_limit, offset], |row| {
                    Ok(CacheSessionListEntry {
                        harness,
                        session_id: row.get(0)?,
                        last_activity_ms: row.get(1)?,
                        title: row.get(2)?,
                    })
                })
                .ok()?;
            Some(rows.flatten().collect())
        },
    )
}

fn opencode_generation_harness(generation: OpenCodeStoreGeneration) -> Harness {
    match generation {
        OpenCodeStoreGeneration::V1 => Harness::Opencode,
        OpenCodeStoreGeneration::V2 => Harness::Opencode2,
    }
}

/// Walks candidate sessions newest first, `page(limit, offset)` at a time,
/// and keeps those that are not hidden and hold at least one cache event,
/// until `limit` are found or the scan budget runs out.
fn filter_opencode_cache_candidates(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
    limit: usize,
    hidden_subagent_ids: &HashSet<String>,
    presence_cache: &mut OpenCodeCachePresenceCache,
    mut page: impl FnMut(i64, i64) -> Option<Vec<CacheSessionListEntry>>,
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
    let (recent_messages_sql, first_event_sql) = match generation {
        OpenCodeStoreGeneration::V1 => (
            RECENT_OPENCODE_SESSION_MESSAGES_SQL,
            FIRST_OPENCODE_CACHE_EVENT_SQL,
        ),
        OpenCodeStoreGeneration::V2 => (
            RECENT_OPENCODE2_SESSION_MESSAGES_SQL,
            FIRST_OPENCODE2_CACHE_EVENT_SQL,
        ),
    };
    let Ok(mut recent_messages_stmt) = conn.prepare(recent_messages_sql) else {
        return Vec::new();
    };
    let Ok(mut event_stmt) = conn.prepare(first_event_sql) else {
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
        let Some(page) = page(page_limit, offset) else {
            break;
        };
        let page_len = page.len();
        scanned = scanned.saturating_add(page_len);

        for candidate in page {
            if hidden_subagent_ids.contains(&candidate.session_id) {
                continue;
            }
            // A session that once held a cache event is not probed again when
            // its activity moves; only a session without one is. Re-probing
            // every active session read up to 200 of its newest message
            // bodies on every poll. (A revert that deletes every assistant
            // message would leave the session listed with an empty window.)
            let cached_presence = presence_cache
                .get(&candidate.session_id)
                .filter(|(time_updated, has_event)| {
                    *has_event || *time_updated == candidate.last_activity_ms
                })
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

/// The Claude Code, Codex and Broca sessions among `keys` that Magic Context
/// holds state for in its store.db. Those hosts have no Magic Context plugin
/// state of their own, so this is how the dashboard knows Magic Context runs
/// in one of their sessions.
fn load_mc_state_sessions(keys: &HashSet<(Harness, String)>) -> HashSet<(Harness, String)> {
    // Most timelines (OpenCode, Pi) have no such session; skip the store then.
    if !keys
        .iter()
        .any(|(harness, _)| harness.mc_state_lives_in_store())
    {
        return HashSet::new();
    }
    let Some(path) = resolve_store_db_path() else {
        return HashSet::new();
    };
    load_mc_state_sessions_from_path(&path, keys)
}

fn load_mc_state_sessions_from_path(
    path: &Path,
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    let Ok(conn) = open_readonly(&path.to_path_buf()) else {
        return HashSet::new();
    };
    load_mc_state_sessions_from_conn(&conn, keys)
}

fn load_mc_state_sessions_from_conn(
    conn: &Connection,
    keys: &HashSet<(Harness, String)>,
) -> HashSet<(Harness, String)> {
    let external_session_ids: Vec<String> = keys
        .iter()
        .filter(|(harness, _)| harness.mc_state_lives_in_store())
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
            harness.mc_state_lives_in_store() && managed_ids.contains(session_id)
        })
        .cloned()
        .collect()
}

/// Whether the Cache list shows this session by default. "Managed" here means
/// one of our own systems runs the session (every Broca run) or Magic Context
/// runs in it; it does not mean Magic Context manages the session's context.
/// See `session_context_reduced_by_mc` for that.
fn is_managed_cache_session(
    harness: Harness,
    session_id: &str,
    detected: &HashSet<(Harness, String)>,
) -> bool {
    harness.has_magic_context_plugin_state()
        || harness == Harness::Broca
        || detected.contains(&(harness, session_id.to_string()))
}

/// Whether Magic Context manages this session's context, so a prompt drop in
/// it is Magic Context's reclaim. True on hosts with Magic Context plugin
/// state, and on Claude Code, Codex and Broca only when store.db holds Magic
/// Context state for the session (`mc_state` from `load_mc_state_sessions`).
/// Unlike `is_managed_cache_session`, a Broca session is not counted by
/// default.
fn session_context_reduced_by_mc(
    harness: Harness,
    session_id: &str,
    mc_state: &HashSet<(Harness, String)>,
) -> bool {
    harness.has_magic_context_plugin_state()
        || (harness.mc_state_lives_in_store()
            && mc_state.contains(&(harness, session_id.to_string())))
}

pub fn load_cache_session_titles(
    keys: &HashSet<(Harness, String)>,
) -> HashMap<(Harness, String), String> {
    let mut titles = HashMap::new();
    let opencode_ids: Vec<String> = keys
        .iter()
        .filter(|(harness, _)| matches!(harness, Harness::Opencode | Harness::Opencode2))
        .map(|(_, sid)| sid.clone())
        .collect();
    if !opencode_ids.is_empty() {
        for store_titles in
            for_each_opencode_store(&readable_opencode_stores(), |_, conn, resolved| {
                let mut store_titles = Vec::new();
                for &generation in &resolved.generations {
                    let harness = opencode_generation_harness(generation);
                    let placeholders = vec!["?"; opencode_ids.len()].join(",");
                    let sql = format!(
                        "SELECT id, COALESCE(title, '') FROM {} WHERE id IN ({placeholders})",
                        opencode_session_table(generation)
                    );
                    if let Ok(mut stmt) = conn.prepare(&sql) {
                        if let Ok(rows) = stmt
                            .query_map(params_from_iter(opencode_ids.iter()), |row| {
                                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                            })
                        {
                            for (sid, title) in rows.flatten() {
                                if !title.is_empty() && resolved.owns(&sid, generation) {
                                    store_titles.push(((harness, sid), title));
                                }
                            }
                        }
                    }
                }
                store_titles
            })
        {
            for (key, title) in store_titles {
                titles.entry(key).or_insert(title);
            }
        }
    }

    for (harness, sessions) in [
        (Harness::Pi, pi_sessions::scan_pi_session_dir()),
        (Harness::Omp, pi_sessions::scan_omp_session_dir()),
    ] {
        for meta in sessions {
            let key = (harness, meta.session_id.clone());
            if keys.contains(&key) {
                titles.insert(key, clean_pi_title(meta.session_name, &meta.first_message));
            }
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
    for harness in [
        Harness::Opencode,
        Harness::Opencode2,
        Harness::Pi,
        Harness::Omp,
    ] {
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
        for harness in [
            Harness::Opencode,
            Harness::Opencode2,
            Harness::Pi,
            Harness::Omp,
        ] {
            if harness_filter.map_or(true, |filter| filter == harness) {
                pre_cap_subagent_flags.extend(
                    load_subagent_map_for_harness(harness)
                        .into_iter()
                        .map(|(session_id, is_subagent)| ((harness, session_id), is_subagent)),
                );
            }
        }
        // OpenCode's own parent ids only matter when OpenCode sessions are
        // listed; reading them for another harness filter cost every poll.
        if harness_filter.map_or(true, |filter| {
            matches!(filter, Harness::Opencode | Harness::Opencode2)
        }) {
            mark_opencode_store_children_as_subagents(&mut pre_cap_subagent_flags);
        }
    }
    let hidden_opencode_ids: HashSet<String> = pre_cap_subagent_flags
        .iter()
        .filter(|((harness, _), is_subagent)| {
            matches!(harness, Harness::Opencode | Harness::Opencode2) && **is_subagent
        })
        .map(|((_, session_id), _)| session_id.clone())
        .collect();
    let includes_harness = |harness| harness_filter.map_or(true, |filter| filter == harness);

    let (
        (mut sessions, opencode_activity_note),
        pi_sessions,
        omp_sessions,
        claude_sessions,
        codex_sessions,
    ) = std::thread::scope(|scope| {
        let opencode = scope.spawn(|| {
            // One OpenCode database serves both harness filters: the
            // store's generation decides whether its rows are OpenCode or
            // OpenCode 2, so rows of the other generation are dropped here.
            if includes_harness(Harness::Opencode) || includes_harness(Harness::Opencode2) {
                load_recent_opencode_cache_sessions(limit, &hidden_opencode_ids, includes_harness)
            } else {
                (Vec::new(), None)
            }
        });
        let pi = scope.spawn(|| {
            if includes_harness(Harness::Pi) {
                pi_sessions::scan_pi_cache_session_dir()
            } else {
                Vec::new()
            }
        });
        let omp = scope.spawn(|| {
            if includes_harness(Harness::Omp) {
                pi_sessions::scan_omp_cache_session_dir()
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
            omp.join().unwrap_or_default(),
            claude.join().unwrap_or_default(),
            codex.join().unwrap_or_default(),
        )
    });
    if includes_harness(Harness::Broca) {
        sessions.extend(load_broca_cache_sessions(limit));
    }
    sessions.extend(pi_sessions.into_iter().map(|meta| CacheSessionListEntry {
        harness: Harness::Pi,
        session_id: meta.session_id,
        last_activity_ms: meta.modified,
        title: Some(clean_pi_title(meta.session_name, &meta.first_message)),
    }));
    sessions.extend(omp_sessions.into_iter().map(|meta| CacheSessionListEntry {
        harness: Harness::Omp,
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
    let detected_managed = load_mc_state_sessions(&candidate_keys);
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
        let mut flags = load_cache_subagent_flags(&stat_keys);
        mark_opencode_store_children_as_subagents(&mut flags);
        flags
    };

    sessions
        .into_iter()
        .map(|row| {
            let key = (row.harness, row.session_id.clone());
            let broca = if row.harness == Harness::Broca {
                BROCA_RUN_INDEX
                    .get()
                    .and_then(|cache| cache.lock().ok())
                    .and_then(|cache| {
                        cache
                            .as_ref()
                            .and_then(|(_, _, index)| index.summary(&row.session_id))
                    })
            } else {
                None
            };
            SessionCacheStats {
                harness: row.harness,
                session_id: row.session_id,
                event_count: 0,
                total_cache_read: 0,
                total_cache_write: 0,
                total_input: 0,
                hit_ratio: 0.0,
                last_timestamp: if broca
                    .as_ref()
                    .is_some_and(|summary| summary.last_activity_ms.is_none())
                {
                    String::new()
                } else {
                    format_timestamp_iso(row.last_activity_ms)
                },
                last_activity_ms: row.last_activity_ms,
                bust_count: 0,
                managed: is_managed_cache_session(row.harness, &key.1, &detected_managed),
                is_subagent: subagent_flags.get(&key).copied().unwrap_or(false),
                title: row.title,
                activity_note: (row.harness == Harness::Opencode2)
                    .then_some(opencode_activity_note)
                    .flatten()
                    .map(str::to_owned),
                broca,
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
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CacheEventsError {
    UnsupportedHarness { harness: Harness },
}

pub fn get_session_cache_events(
    harness: Harness,
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Result<Vec<DbCacheEvent>, CacheEventsError> {
    Ok(match harness {
        Harness::Opencode | Harness::Opencode2 => {
            get_opencode_session_cache_events(session_id, limit, since_timestamp)
        }
        Harness::Pi | Harness::Omp => {
            get_pi_session_cache_events(harness, session_id, limit, since_timestamp)
        }
        Harness::ClaudeCode => {
            get_claude_code_session_cache_events(session_id, limit, since_timestamp)
        }
        Harness::Codex => get_codex_session_cache_events(session_id, limit, since_timestamp),
        Harness::Broca => return Err(CacheEventsError::UnsupportedHarness { harness }),
    })
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
) -> Result<Vec<DbCacheEvent>, CacheEventsError> {
    let max_events = (target_turns * 50).max(200); // floor to existing limit
    let raw = match harness {
        Harness::Opencode | Harness::Opencode2 => {
            get_opencode_session_cache_events(session_id, Some(max_events), None)
        }
        Harness::Pi | Harness::Omp => {
            get_pi_session_cache_events(harness, session_id, Some(max_events), None)
        }
        Harness::ClaudeCode => {
            get_claude_code_session_cache_events(session_id, Some(max_events), None)
        }
        Harness::Codex => get_codex_session_cache_events(session_id, Some(max_events), None),
        Harness::Broca => return Err(CacheEventsError::UnsupportedHarness { harness }),
    };
    Ok(trim_events_to_turns(raw, target_turns))
}

fn get_opencode_session_cache_events(
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    with_opencode_session_store(session_id, |conn, generation| {
        get_opencode_session_cache_events_from_conn(
            conn,
            generation,
            session_id,
            limit,
            since_timestamp,
        )
    })
    .unwrap_or_default()
}

fn get_opencode_session_cache_events_from_conn(
    conn: &Connection,
    generation: OpenCodeStoreGeneration,
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    const V1_COLS: &str = "SELECT CAST(id AS TEXT), session_id, time_created,
                COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0),
                CAST(json_extract(data, '$.agent') AS TEXT),
                 CAST(json_extract(data, '$.finish') AS TEXT),
                 CAST(json_extract(data, '$.parentID') AS TEXT),
                 CAST(COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS TEXT),
                 CAST(COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')) AS TEXT)
         FROM message
         WHERE session_id = ?1
           AND json_extract(data, '$.role') = 'assistant'
           AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0";
    const V2_COLS: &str = "SELECT CAST(id AS TEXT), session_id, time_created,
                COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0),
                COALESCE(CAST(json_extract(data, '$.tokens.input') AS INTEGER), 0)
                  + COALESCE(CAST(json_extract(data, '$.tokens.output') AS INTEGER), 0)
                  + COALESCE(CAST(json_extract(data, '$.tokens.reasoning') AS INTEGER), 0)
                  + COALESCE(CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER), 0)
                  + COALESCE(CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER), 0),
                CAST(json_extract(data, '$.agent') AS TEXT), NULL, NULL,
                CAST(COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS TEXT),
                CAST(COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.id')) AS TEXT)
         FROM session_message
         WHERE session_id = ?1
           AND type = 'assistant'
           AND json_extract(data, '$.tokens') IS NOT NULL";
    let cols = match generation {
        OpenCodeStoreGeneration::V1 => V1_COLS,
        OpenCodeStoreGeneration::V2 => V2_COLS,
    };
    let harness = match generation {
        OpenCodeStoreGeneration::V1 => Harness::Opencode,
        OpenCodeStoreGeneration::V2 => Harness::Opencode2,
    };

    // Incremental (since): everything at/after the anchor, chronological. No
    // LIMIT — a 1s poll's delta is tiny, and the >= overlap is a single row.
    // Full (no since): the most-recent `limit`, DESC + LIMIT; build_db_cache_events
    // re-sorts ASC to chronological.
    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match since_timestamp {
        Some(since) => (
            format!("{cols} AND time_created >= ?2 ORDER BY time_created ASC"),
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
                format!("{cols} ORDER BY time_created DESC LIMIT ?2"),
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
            harness,
            message_id: row.get(0)?,
            session_id: row.get(1)?,
            timestamp: row.get(2)?,
            input_tokens: row.get(3)?,
            cache_read: row.get(4)?,
            cache_write: row.get(5)?,
            total_tokens: row.get(6)?,
            agent: row.get(7)?,
            finish: row.get(8)?,
            native_turn_id: row.get(9)?,
            context_limit: None,
            provider: row.get(10)?,
            model: row.get(11)?,

            cache_reported: true,
        })
    }) else {
        return Vec::new();
    };
    build_db_cache_events(rows.flatten().collect(), true)
}

fn get_pi_session_cache_events(
    harness: Harness,
    session_id: &str,
    limit: Option<usize>,
    since_timestamp: Option<i64>,
) -> Vec<DbCacheEvent> {
    let Some(path) = find_pi_session_path_for_harness(harness, session_id) else {
        return Vec::new();
    };
    let Some(detail) = pi_sessions::read_pi_session_detail(&path) else {
        return Vec::new();
    };
    let mut rows: Vec<RawDbCacheEvent> = detail
        .messages
        .iter()
        .filter(|message| message.role == "assistant")
        .filter_map(|message| {
            let usage = message.usage.as_ref()?;
            let (provider, model) = pi_message_provider_model(&message.raw_json);
            (usage.total > 0).then(|| RawDbCacheEvent {
                harness,
                message_id: message.entry_id.clone(),
                session_id: session_id.to_string(),
                timestamp: message.timestamp_ms,
                input_tokens: usage.input as i64,
                cache_read: usage.cache_read as i64,
                cache_write: usage.cache_write as i64,
                total_tokens: usage.total as i64,
                agent: None,
                finish: message.stop_reason.clone(),
                native_turn_id: None,
                context_limit: None,
                provider,
                model,

                cache_reported: true,
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
            native_turn_id: None,
            context_limit: event.context_limit,
            provider: harness.jsonl_provider().map(str::to_owned),
            model: event.model.clone(),

            cache_reported: true,
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

/// Resolve context project identities only against the supplied store and OpenCode stores.
/// Config discovery must not scan the operator's other session directories.
pub(crate) fn get_projects_for_config(
    conn: &Connection,
    opencode_stores: &[ReadableStore],
) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let mut projects = get_project_identities(conn)?;
    let identities = load_session_identity_map_from_conn(conn);
    let mut paths = HashMap::new();
    let mut names = HashMap::new();
    for_each_opencode_store(opencode_stores, |_, opencode, resolved| {
        for &generation in &resolved.generations {
            let harness = opencode_generation_harness(generation);
            if let Ok(mut stmt) = opencode.prepare(&format!(
                "SELECT id, directory FROM {} WHERE directory IS NOT NULL AND directory != ''",
                opencode_session_table(generation)
            )) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }) {
                    for (session_id, directory) in rows.flatten() {
                        if !resolved.owns(&session_id, generation) {
                            continue;
                        }
                        let identity = lookup_session_identity(&identities, harness, &session_id);
                        if !identity.is_empty() {
                            paths.insert(directory, identity);
                        }
                    }
                }
            }
        }
        if let Ok(mut stmt) = opencode.prepare("SELECT name, worktree FROM project") {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
            }) {
                for (name, path) in rows.flatten() {
                    if let Some(name) = name.filter(|name| !name.is_empty()) {
                        names.insert(path.clone(), name);
                    }
                    paths
                        .entry(path.clone())
                        .or_insert_with(|| normalize_stored_project_path(&path));
                }
            }
        }
    });
    for project in &mut projects {
        if let Some((path, _)) = paths
            .iter()
            .find(|(_, identity)| *identity == &project.identity)
        {
            project.label = names.get(path).cloned().unwrap_or_else(|| basename(path));
            project.path = Some(path.clone());
        }
    }
    Ok(projects)
}

fn get_project_identities(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    let workspace_identities =
        crate::workspaces::extra_workspace_member_identities(conn).unwrap_or_default();

    // UNION only the project-path sources that exist. The dashboard opens the
    // DB read-only and never migrates, so a DB older than the Dreamer V2 schema
    // lacks task_schedule_state / dream_runs; an unconditional UNION would throw
    // "no such table" and break the Projects page instead of degrading. On a
    // store whose memories this dashboard doesn't read, projects come from the
    // other sources alone.
    let mut sources = Vec::new();
    if crate::db_capabilities::memory_store_ready(conn) {
        sources.push(
            "SELECT owner_id AS project_path FROM memories WHERE level = 'project'".to_string(),
        );
    }
    if table_exists(conn, "task_schedule_state") {
        sources.push("SELECT project_path FROM task_schedule_state".to_string());
    }
    if table_exists(conn, "dream_runs") {
        sources.push("SELECT project_path FROM dream_runs".to_string());
    }
    let stored_values: Vec<String> = if sources.is_empty() {
        Vec::new()
    } else {
        let union_sql = format!(
            "{} ORDER BY project_path",
            sources.join("\n         UNION\n         ")
        );
        let mut stmt = conn.prepare(&union_sql)?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let mut identity_set: HashSet<String> = stored_values
        .into_iter()
        .map(|value| normalize_stored_project_path(&value))
        .filter(|identity| !identity.is_empty())
        .collect();
    identity_set.extend(workspace_identities);
    let mut identities: Vec<String> = identity_set.into_iter().collect();
    identities.sort();

    let projects = identities
        .into_iter()
        .map(|id| ProjectInfo {
            label: id.clone(),
            identity: id,
            path: None,
        })
        .collect();
    Ok(projects)
}

pub fn get_projects(conn: &Connection) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    get_projects_with_names(conn, &crate::project_names::cache().snapshot())
}

fn get_projects_with_names(
    conn: &Connection,
    names: &crate::project_names::ProjectNames,
) -> Result<Vec<ProjectInfo>, rusqlite::Error> {
    // Use the same enumeration as the project list shown to the user.
    let identity_to_row: HashMap<String, ProjectRow> = enumerate_projects_filtered(None)
        .into_iter()
        .map(|row| (row.identity.clone(), row))
        .collect();

    let projects = get_project_identities(conn)?
        .into_iter()
        .map(|project| {
            let id = project.identity;
            let (label, path) = if let Some(label) = crate::project_names::pj_label(&id, names) {
                (
                    label,
                    identity_to_row.get(&id).map(|row| row.primary_path.clone()),
                )
            } else if let Some(row) = identity_to_row.get(&id) {
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
    enumerate_memory_projects_with_names(conn, &crate::project_names::cache().snapshot())
}

fn enumerate_memory_projects_with_names(
    conn: &Connection,
    names: &crate::project_names::ProjectNames,
) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let mut stmt = conn.prepare(
        "SELECT DISTINCT owner_id
         FROM memories
         WHERE level = 'project' AND status = 'active'
         ORDER BY owner_id",
    )?;
    let memory_project_values: HashSet<String> = stmt
        .query_map([], |row| row.get(0))?
        .collect::<Result<HashSet<_>, _>>()?;

    // Memory rows usually store a resolved project identity (`git:`, `dir:` or
    // `pj-`). Some old rows may still store a raw filesystem path.
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
    for row in &mut all {
        if let Some(label) = crate::project_names::pj_label(&row.identity, names) {
            row.display_name = label;
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

    for_each_opencode_store(&readable_opencode_stores(), |_, conn, resolved| {
        for &generation in &resolved.generations {
            let harness = opencode_generation_harness(generation);
            if let Ok(mut stmt) = conn.prepare(&format!(
                "SELECT id, COALESCE(directory, '')
                 FROM {}
                 WHERE directory IS NOT NULL AND directory != ''",
                opencode_session_table(generation)
            )) {
                if let Ok(rows) = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }) {
                    for (session_id, dir) in rows.flatten() {
                        if !resolved.owns(&session_id, generation) {
                            continue;
                        }
                        let identity = lookup_session_identity(identities, harness, &session_id);
                        if !identity.is_empty() {
                            dirs.push((identity, dir));
                        }
                    }
                }
            }
        }
    });

    for (harness, sessions) in [
        (Harness::Pi, pi_sessions::scan_pi_session_dir()),
        (Harness::Omp, pi_sessions::scan_omp_session_dir()),
    ] {
        for meta in sessions {
            if meta.cwd.is_empty() {
                continue;
            }
            let identity = lookup_session_identity(identities, harness, &meta.session_id);
            if !identity.is_empty() {
                dirs.push((identity, meta.cwd));
            }
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

    for_each_opencode_store(&readable_opencode_stores(), |_, conn, resolved| {
        for &generation in &resolved.generations {
            let harness = opencode_generation_harness(generation);
            if let Ok(mut stmt) = conn.prepare(&format!(
                "SELECT p.name, p.worktree, COUNT(s.id)
                 FROM project p LEFT JOIN {} s ON s.project_id = p.id
                 GROUP BY p.id, p.name, p.worktree",
                if generation == OpenCodeStoreGeneration::V1
                    && resolved.generations.contains(&OpenCodeStoreGeneration::V2)
                {
                    "(SELECT * FROM session WHERE id NOT IN (SELECT id FROM session_v2))"
                } else {
                    opencode_session_table(generation)
                }
            )) {
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
                        if count > 0 {
                            entry.harnesses.insert(harness);
                        }
                        entry.session_count =
                            entry.session_count.saturating_add(count.max(0) as u32);
                    }
                }
            }
        }
    });

    let mut pi_counts: HashMap<(Harness, String), (String, u32)> = HashMap::new();
    for (harness, sessions) in [
        (Harness::Pi, pi_sessions::scan_pi_session_dir()),
        (Harness::Omp, pi_sessions::scan_omp_session_dir()),
    ] {
        for meta in sessions {
            if let Some(allowed_paths) = project_paths_filter {
                if !allowed_paths.contains(&meta.cwd) {
                    continue;
                }
            }
            let identity = lookup_session_identity(&session_identities, harness, &meta.session_id);
            if identity.is_empty() {
                continue;
            }
            let entry = pi_counts
                .entry((harness, identity))
                .or_insert((meta.cwd, 0));
            entry.1 = entry.1.saturating_add(1);
        }
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

    for ((harness, identity), (cwd, count)) in pi_counts {
        let entry = groups.entry(identity).or_default();
        entry.pi_path = Some(cwd);
        entry.harnesses.insert(harness);
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
/// (`list_all_sessions`, all harnesses) grouped by project identity, enriched
/// per group with its active-memory count and workspace name. Primary sessions
/// only count toward `session_count`/`last_activity_ms` (subagents are an
/// implementation detail, not a project the user navigates), but a project that
/// has ONLY subagent sessions still appears (so nothing silently vanishes).
///
/// `conn` is the context.db handle (memories + workspaces). Returns cards sorted
/// by last activity, newest first.
pub fn get_project_cards(conn: &Connection) -> Vec<ProjectCard> {
    get_project_cards_with_names(conn, &crate::project_names::cache().snapshot())
}

fn get_project_cards_with_names(
    conn: &Connection,
    names: &crate::project_names::ProjectNames,
) -> Vec<ProjectCard> {
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
            // Registered identities use the cached name or a short pj- marker.
            // Legacy identities prefer the representative directory's basename:
            // it is the main checkout, not a recent worktree's bg_<hash> label.
            // They fall back to the session-derived label, then a short identity.
            let display_name = if let Some(label) = crate::project_names::pj_label(&identity, names)
            {
                label
            } else if !primary_path.is_empty() {
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

// ── Query implementations ─────────────────────────────────────────

/// The columns `map_memory_row` reads, in its order. A memory's owner is the
/// project it shows under, and the tag it was written under is its category.
/// `has_embedding` uses EXISTS instead of LEFT JOIN so a memory with multiple
/// model-specific embedding rows still appears once in the result set.
const MEMORY_SELECT: &str = "m.id, m.owner_id, m.origin_category, m.content, m.normalized_hash,
    m.source_session_id, m.source_type, m.seen_count, m.retrieval_count,
    m.first_seen_at, m.created_at, m.updated_at, m.last_seen_at,
    m.last_retrieved_at, m.status, m.expires_at, m.verification_status,
    m.verified_at, m.superseded_by_memory_id, m.merged_from, m.metadata_json,
    m.importance, m.scope, m.shareable,
    (EXISTS (SELECT 1 FROM memory_embeddings me WHERE me.memory_id = m.id)) AS has_embedding,
    m.revision";

/// Resolve a project filter value (an identity like `git:<hash>` / `dir:<sha>`,
/// or a legacy raw filesystem path) into the set of project-memory owners
/// (`memories.owner_id`) that should be matched against.
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
    resolve_stored_paths(
        conn,
        "SELECT DISTINCT owner_id FROM memories WHERE level = 'project'",
        project_filter,
    )
}

/// Count the ACTIVE (active + permanent) project memories whose owner
/// normalizes to `member_identity`. Archived/superseded rows are excluded — the
/// project card and workspace member count both want the live, injectable pool
/// (matching the Memories tab's "N active" headline), not the full historical
/// table (which is dominated by archived rows after curation).
pub fn count_memories_matching_identity(
    conn: &Connection,
    member_identity: &str,
) -> Result<i64, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let paths = resolve_paths_for_memory_filter(conn, member_identity)?;
    if paths.is_empty() {
        return Ok(0);
    }
    let placeholders = build_in_placeholders(paths.len(), 1);
    let sql = format!(
        "SELECT COUNT(*) FROM memories
         WHERE level = 'project' AND status IN ('active', 'permanent') AND owner_id IN ({})",
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
    resolve_stored_paths(
        conn,
        &format!("SELECT DISTINCT project_path FROM {table}"),
        project_filter,
    )
}

/// The stored project values `distinct_sql` returns that normalize to the same
/// identity as `project_filter`, or the raw filter when none does.
fn resolve_stored_paths(
    conn: &Connection,
    distinct_sql: &str,
    project_filter: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(distinct_sql)?;
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

/// A `LIKE ... ESCAPE '\'` pattern that matches `raw` literally anywhere in the
/// value. The escape character itself must be escaped first: an unescaped `\`
/// would swallow the next character, so a Windows path like `C:\Users` would
/// only match `C:Users`.
fn like_contains_pattern(raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len() + 2);
    escaped.push('%');
    for ch in raw.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped.push('%');
    escaped
}

/// Parse a search box value that is exactly a memory ID: digits, optionally
/// prefixed with `#` (the form agents use when citing a memory, e.g. `#831`),
/// with surrounding whitespace ignored. Anything else, including an ID that
/// does not fit in an i64, returns None and is searched as ordinary text.
fn parse_memory_id_query(search_query: Option<&str>) -> Option<i64> {
    let trimmed = search_query?.trim();
    let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Restricts a memory list query to one memory ID, or excludes one.
#[derive(Clone, Copy)]
enum MemoryIdCondition {
    Only(i64),
    Exclude(i64),
}

/// List memories for the Memories view.
///
/// When the search text is exactly a memory ID (`1234` or `#1234`) and that
/// memory passes the project/workspace/status/category filters, the result is
/// that memory followed by the normal text-search results with it removed.
/// `limit`/`offset` page through that combined list, so the exact match only
/// appears on the first page. An ID that does not exist or is filtered out
/// leaves the ordinary text search unchanged.
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
    get_memories_filtered(
        conn,
        project_filter,
        workspace_filter,
        status_filter,
        category_filter,
        search_query,
        false,
        limit,
        offset,
    )
}

/// Same list as [`get_memories`]. `exclude_archived` drops archived rows when
/// no exact status is set, which is the Memories tab default: category totals
/// omit archived rows, and the page must be able to reach every counted row.
#[allow(clippy::too_many_arguments)]
pub fn get_memories_filtered(
    conn: &Connection,
    project_filter: Option<&str>,
    workspace_filter: Option<i64>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    exclude_archived: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    let run =
        |search: Option<&str>, id_condition: Option<MemoryIdCondition>, limit: i64, offset: i64| {
            query_memories(
                conn,
                project_filter,
                workspace_filter,
                status_filter,
                category_filter,
                search,
                id_condition,
                exclude_archived,
                limit,
                offset,
            )
        };

    // A zero limit asks for no rows; skip the ID lookup so it cannot add one.
    if let Some(id) = parse_memory_id_query(search_query).filter(|_| limit != 0) {
        // The exact lookup runs without the search text but with every view
        // filter, so an ID outside the current filters is not surfaced.
        let exact = run(None, Some(MemoryIdCondition::Only(id)), 1, 0)?
            .into_iter()
            .next();
        if let Some(exact) = exact {
            // The combined list is [exact match, text results without it...].
            // The first page holds the exact match plus one fewer text row;
            // later pages read the text results shifted back by one. A negative
            // limit means "no limit" to SQLite and is passed through as-is.
            let text_condition = Some(MemoryIdCondition::Exclude(id));
            if offset > 0 {
                return run(search_query, text_condition, limit, offset - 1);
            }
            let text_limit = if limit > 0 { limit - 1 } else { limit };
            let mut rows = vec![exact];
            if text_limit != 0 {
                rows.extend(run(search_query, text_condition, text_limit, 0)?);
            }
            return Ok(rows);
        }
    }

    run(search_query, None, limit, offset)
}

/// The filtered FTS/LIKE/unfiltered memory list behind `get_memories`, with an
/// optional condition that keeps or drops a single memory ID.
#[allow(clippy::too_many_arguments)]
fn query_memories(
    conn: &Connection,
    project_filter: Option<&str>,
    workspace_filter: Option<i64>,
    status_filter: Option<&str>,
    category_filter: Option<&str>,
    search_query: Option<&str>,
    id_condition: Option<MemoryIdCondition>,
    exclude_archived: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<Memory>, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;

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
    let like_pattern = like_contains_pattern(&raw_search);

    // Build WHERE clauses and params dynamically. Only project memories are
    // listed: a global memory is a user memory, which has its own screen.
    let mut conditions = vec!["m.level = 'project'".to_string()];
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
        conditions.push(format!("m.owner_id IN ({})", placeholders));
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
    } else if exclude_archived {
        // No extra parameter: the clause is a literal, so the LIKE fallback
        // reuses `where_extra` without rebinding it.
        conditions.push("m.status != 'archived'".to_string());
    }
    if let Some(c) = category_filter {
        params.push(Box::new(c.to_string()));
        conditions.push(format!("m.origin_category = ?{}", params.len()));
    }
    // Position in `params` of an excluded ID. The FTS fallback check below
    // binds NULL there instead: `m.id IS NOT NULL` keeps every row, so that
    // check sees the same matches as the search without the exclusion.
    let mut exclude_param_pos = None;
    match id_condition {
        Some(MemoryIdCondition::Only(id)) => {
            params.push(Box::new(id));
            conditions.push(format!("m.id = ?{}", params.len()));
        }
        Some(MemoryIdCondition::Exclude(id)) => {
            exclude_param_pos = Some(params.len());
            params.push(Box::new(id));
            conditions.push(format!("m.id IS NOT ?{}", params.len()));
        }
        None => {}
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
            "SELECT {MEMORY_SELECT}
             FROM memories m
             INNER JOIN memories_fts ON memories_fts.rowid = m.id
             WHERE memories_fts MATCH ?1
             {}
             ORDER BY rank
             LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else if has_search {
        // LIKE fallback for short queries or special-character-heavy input
        format!(
            "SELECT {MEMORY_SELECT}
             FROM memories m
             WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.origin_category LIKE ?1 ESCAPE '\\')
             {}
             ORDER BY m.updated_at DESC
              LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
        )
    } else {
        format!(
            "SELECT {MEMORY_SELECT}
             FROM memories m
             WHERE 1=1
             {}
             ORDER BY m.updated_at DESC
              LIMIT ?{} OFFSET ?{}",
            where_extra, limit_idx, offset_idx,
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
        Ok(empty)
            if use_fts
                && !use_like_fallback
                && (offset > 0 || exclude_param_pos.is_some())
                && {
                    // An empty page past the first one only falls back to LIKE when FTS
                    // matches nothing at all. Otherwise it is just the end of the FTS
                    // results, and a LIKE page at the same offset would splice a
                    // different result set onto the pages already shown. The same holds
                    // for a first page that is empty only because the excluded ID was
                    // the sole FTS match: the caller already shows that memory, and the
                    // search without the exclusion would have stayed on FTS.
                    let mut probe: Vec<&dyn rusqlite::types::ToSql> = params[..params.len() - 2]
                        .iter()
                        .map(|p| p.as_ref())
                        .collect();
                    if let Some(pos) = exclude_param_pos {
                        probe[pos] = &rusqlite::types::Null;
                    }
                    probe.push(&1i64);
                    probe.push(&0i64);
                    conn.prepare(&sql)?
                        .query(probe.as_slice())?
                        .next()?
                        .is_some()
                } =>
        {
            Ok(empty)
        }
        Ok(_empty) if use_fts && !use_like_fallback => {
            // FTS returned nothing — retry with LIKE for better partial matching
            let like_sql = format!(
                "SELECT {MEMORY_SELECT}
                 FROM memories m
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.origin_category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
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
            if let Some(MemoryIdCondition::Only(id) | MemoryIdCondition::Exclude(id)) = id_condition
            {
                like_params.push(Box::new(id));
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
                "SELECT {MEMORY_SELECT}
                 FROM memories m
                 WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.origin_category LIKE ?1 ESCAPE '\\')
                 {}
                 ORDER BY m.updated_at DESC
                 LIMIT ?{} OFFSET ?{}",
                where_extra, limit_idx, offset_idx,
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
            if let Some(MemoryIdCondition::Only(id) | MemoryIdCondition::Exclude(id)) = id_condition
            {
                like_params.push(Box::new(id));
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

fn map_memory_row(row: &rusqlite::Row<'_>) -> Result<Memory, rusqlite::Error> {
    Ok(Memory {
        revision: row.get(25)?,
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
    get_memory_stats_scoped(
        conn,
        MemoryStatsScope {
            project: project_filter,
            workspace_id: workspace_filter,
            status: None,
            search: None,
            include_archived: false,
        },
    )
}

pub fn get_memory_stats_scoped(
    conn: &Connection,
    scope: MemoryStatsScope<'_>,
) -> Result<MemoryStats, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let project_filter = scope.project;
    let workspace_filter = scope.workspace_id;
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

    // Build an `owner_id IN (?, ?, ...)` fragment and the param refs that
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
                format!("owner_id IN ({})", placeholders),
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

    // Only project memories count: a global memory is a user memory, which
    // the user-memory screen counts.
    let total: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("level = 'project'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let active: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("level = 'project' AND status = 'active'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let permanent: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("level = 'project' AND status = 'permanent'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;
    let archived: i64 = conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM memories {}",
            where_with_extra("level = 'project' AND status = 'archived'", has_filter)
        ),
        path_params.as_slice(),
        |r| r.get(0),
    )?;

    // Count distinct memories that have at least one embedding row. Multiple rows per
    // memory (one per model_id) must not inflate this stat.
    let with_embeddings: i64 = if has_filter {
        if resolved_paths.is_empty() {
            // Empty filter resolves to zero rows — honor the same zero-stats
            // contract the other counts get from the `0 = 1` sentinel. Rebuilding
            // an IN-list from an empty resolved_paths would emit invalid
            // `IN ()` SQL and crash the whole stats query.
            0
        } else {
            let qualified_in = format!(
                "m.level = 'project' AND m.owner_id IN ({})",
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
        // Every embedding row except those of memories at another level, so
        // rows whose memory is gone still count, as they always did.
        conn.query_row(
            "SELECT COUNT(DISTINCT memory_id) FROM memory_embeddings
              WHERE memory_id NOT IN (SELECT id FROM memories WHERE level <> 'project')",
            [],
            |r| r.get(0),
        )?
    };

    let categories = category_counts_for_scope(conn, scope)?;

    Ok(MemoryStats {
        total,
        active,
        permanent,
        archived,
        with_embeddings,
        categories,
    })
}

/// Category totals for the memory list. Uses the same project, status, search,
/// and archived-omission rules as `get_memories_filtered`, so a header count is
/// the number of rows that category can page through. Not limited to a page.
fn category_counts_for_scope(
    conn: &Connection,
    scope: MemoryStatsScope<'_>,
) -> Result<Vec<CategoryCount>, rusqlite::Error> {
    let exclude_archived = scope.status.is_none() && !scope.include_archived;
    let search = scope
        .search
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(id) = parse_memory_id_query(search) {
        // Same union as `get_memories_filtered`: an exact ID that passes the
        // view filters is counted even when the text search would miss it, and
        // it is not counted twice when the text search also hits it.
        let exact = query_memories(
            conn,
            scope.project,
            scope.workspace_id,
            scope.status,
            None,
            None,
            Some(MemoryIdCondition::Only(id)),
            exclude_archived,
            1,
            0,
        )?
        .into_iter()
        .next();
        if let Some(exact) = exact {
            let mut counts = aggregate_categories(
                conn,
                scope.project,
                scope.workspace_id,
                scope.status,
                search,
                Some(MemoryIdCondition::Exclude(id)),
                exclude_archived,
            )?;
            add_category_count(&mut counts, &exact.category, 1);
            return Ok(counts);
        }
    }
    aggregate_categories(
        conn,
        scope.project,
        scope.workspace_id,
        scope.status,
        search,
        None,
        exclude_archived,
    )
}

fn add_category_count(counts: &mut Vec<CategoryCount>, category: &str, extra: i64) {
    if let Some(row) = counts.iter_mut().find(|row| row.category == category) {
        row.count += extra;
    } else {
        counts.push(CategoryCount {
            category: category.to_string(),
            count: extra,
        });
    }
    counts.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.category.cmp(&right.category))
    });
}

fn aggregate_categories(
    conn: &Connection,
    project_filter: Option<&str>,
    workspace_filter: Option<i64>,
    status_filter: Option<&str>,
    search_query: Option<&str>,
    id_condition: Option<MemoryIdCondition>,
    exclude_archived: bool,
) -> Result<Vec<CategoryCount>, rusqlite::Error> {
    let raw_search = search_query.unwrap_or("").trim().to_string();
    let has_search = !raw_search.is_empty();
    let sanitized_fts = if has_search {
        let tokens: Vec<String> = raw_search
            .split_whitespace()
            .filter(|token| !token.is_empty())
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect();
        tokens.join(" ")
    } else {
        String::new()
    };
    let use_fts = !sanitized_fts.is_empty();
    let use_like_fallback = has_search && (!use_fts || raw_search.len() < 3);
    let like_pattern = like_contains_pattern(&raw_search);

    // Only project memories, as the memory list shows them.
    let mut conditions = vec!["m.level = 'project'".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if use_fts && !use_like_fallback {
        params.push(Box::new(sanitized_fts));
    } else if has_search {
        params.push(Box::new(like_pattern.clone()));
    }

    let resolved_paths: Vec<String> = if let Some(ws_id) = workspace_filter {
        crate::workspaces::resolve_workspace_filter_paths(conn, ws_id)?
    } else if let Some(project) = project_filter {
        resolve_paths_for_memory_filter(conn, project)?
    } else {
        Vec::new()
    };
    if !resolved_paths.is_empty() {
        let start_idx = params.len() + 1;
        for path in &resolved_paths {
            params.push(Box::new(path.clone()));
        }
        conditions.push(format!(
            "m.owner_id IN ({})",
            build_in_placeholders(resolved_paths.len(), start_idx)
        ));
    } else if workspace_filter.is_some() || project_filter.is_some() {
        conditions.push("0 = 1".to_string());
    }
    if let Some(status) = status_filter {
        params.push(Box::new(status.to_string()));
        conditions.push(format!("m.status = ?{}", params.len()));
    } else if exclude_archived {
        conditions.push("m.status != 'archived'".to_string());
    }
    let mut exclude_param_pos = None;
    match id_condition {
        Some(MemoryIdCondition::Only(id)) => {
            params.push(Box::new(id));
            conditions.push(format!("m.id = ?{}", params.len()));
        }
        Some(MemoryIdCondition::Exclude(id)) => {
            exclude_param_pos = Some(params.len());
            params.push(Box::new(id));
            conditions.push(format!("m.id IS NOT ?{}", params.len()));
        }
        None => {}
    }
    let where_extra = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    let map_counts = |sql: &str, bound: &[Box<dyn rusqlite::types::ToSql>]| {
        let mut stmt = conn.prepare(sql)?;
        let refs: Vec<&dyn rusqlite::types::ToSql> =
            bound.iter().map(|param| param.as_ref()).collect();
        let rows = stmt.query_map(refs.as_slice(), |row| {
            Ok(CategoryCount {
                category: row.get(0)?,
                count: row.get(1)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
    };

    let grouped = |from_where: &str| {
        format!(
            "SELECT m.origin_category, COUNT(*) AS cnt {from_where} {where_extra} GROUP BY m.origin_category ORDER BY cnt DESC, m.origin_category ASC"
        )
    };

    if use_fts && !use_like_fallback {
        let sql = grouped(
            "FROM memories m INNER JOIN memories_fts ON memories_fts.rowid = m.id WHERE memories_fts MATCH ?1",
        );
        match map_counts(&sql, &params) {
            Ok(counts) if !counts.is_empty() => return Ok(counts),
            Ok(empty) => {
                // An empty FTS aggregate falls back to LIKE only when FTS itself
                // matches nothing. An exclusion that removed the only FTS hit
                // must stay on FTS, or the count would include substring hits
                // the list does not show.
                let fts_has_hits = if exclude_param_pos.is_some() {
                    let mut probe: Vec<&dyn rusqlite::types::ToSql> =
                        params.iter().map(|param| param.as_ref()).collect();
                    if let Some(pos) = exclude_param_pos {
                        probe[pos] = &rusqlite::types::Null;
                    }
                    let probe_sql = format!(
                        "SELECT 1 FROM memories m INNER JOIN memories_fts ON memories_fts.rowid = m.id WHERE memories_fts MATCH ?1 {where_extra} LIMIT 1"
                    );
                    conn.prepare(&probe_sql)?
                        .query(probe.as_slice())?
                        .next()?
                        .is_some()
                } else {
                    false
                };
                if fts_has_hits {
                    return Ok(empty);
                }
            }
            Err(error) => {
                eprintln!("FTS category count failed, falling back to LIKE: {error}");
            }
        }
    } else if !has_search {
        let sql = grouped("FROM memories m WHERE 1=1");
        return map_counts(&sql, &params);
    }

    let like_sql = grouped(
        "FROM memories m WHERE (m.content LIKE ?1 ESCAPE '\\' OR m.origin_category LIKE ?1 ESCAPE '\\')",
    );
    let mut like_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    like_params.push(Box::new(like_pattern));
    for path in &resolved_paths {
        like_params.push(Box::new(path.clone()));
    }
    if let Some(status) = status_filter {
        like_params.push(Box::new(status.to_string()));
    }
    if let Some(MemoryIdCondition::Only(id) | MemoryIdCondition::Exclude(id)) = id_condition {
        like_params.push(Box::new(id));
    }
    map_counts(&like_sql, &like_params)
}

fn mutation_race_error() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn bump_project_memory_epoch_for_identity(
    tx: &Transaction<'_>,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    if identity.is_empty() {
        return Ok(());
    }

    tx.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, updated_at)
         VALUES (?1, 1, ?2)
         ON CONFLICT(project_path) DO UPDATE SET
           project_memory_epoch = project_memory_epoch + 1,
           updated_at = excluded.updated_at",
        params![identity, now_millis()],
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
    crate::writer_diagnostics::statement("invalidate_memory_caches", || {
        if table_exists(conn, "session_render_cache")
            && !table_has_column(conn, "session_meta", "cached_m0_bytes")
        {
            let normalized = !table_has_column(conn, "session_meta", "memory_block_ids");
            let ids = if normalized {
                "session_id IN (SELECT session_id FROM session_meta_chunks WHERE column_name='memory_block_ids'
                    AND (chunk>=0 OR (chunk=-1 AND (body='blob' OR typeof(body) IN ('integer','real')))))"
            } else {
                "memory_block_ids != ''"
            };
            conn.execute_batch("SAVEPOINT invalidate_memory_payloads")?;
            let result = (|| -> Result<usize, rusqlite::Error> {
                let sessions: Vec<String> = {
                    let mut query = conn.prepare(&format!("SELECT session_id FROM session_meta WHERE {ids}
                        OR cached_m0_max_memory_mutation_id IS NOT NULL
                        OR session_id IN (SELECT session_id FROM session_render_cache
                            WHERE (cache_key IN ('cached_m0_bytes','cached_m1_bytes') AND value IS NOT NULL)
                               OR (cache_key='memory_block_cache' AND value != ''))"))?;
                    let rows = query.query_map([], |row| row.get(0))?;
                    rows.collect::<Result<_, _>>()?
                };
                let reset = if normalized {
                    "UPDATE session_meta SET cached_m0_max_memory_mutation_id=NULL WHERE session_id=?1"
                } else {
                    "UPDATE session_meta SET memory_block_ids='',cached_m0_max_memory_mutation_id=NULL WHERE session_id=?1"
                };
                for session in &sessions {
                    conn.execute(reset, [session])?;
                    conn.execute("DELETE FROM session_render_cache WHERE session_id=?1 AND cache_key IN ('cached_m0_bytes','cached_m1_bytes','memory_block_cache')", [session])?;
                    if normalized {
                        conn.execute("DELETE FROM session_meta_chunks WHERE session_id=?1 AND column_name='memory_block_ids'", [session])?;
                    }
                }
                Ok(sessions.len())
            })();
            if result.is_err() {
                let _ = conn.execute_batch("ROLLBACK TO invalidate_memory_payloads");
            }
            conn.execute_batch("RELEASE invalidate_memory_payloads")?;
            return result;
        }
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
    })
}

pub fn update_memory_status(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

pub fn update_memory_content(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

pub fn update_memory_category(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

/// Project-memory deletion is an undoable archive, never a physical deletion.
pub fn delete_memory(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

pub fn bulk_update_memory_status(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

/// Archive all requested rows atomically, save one history event and retry result,
/// and send one rebuild signal per affected project.
pub fn bulk_delete_memory(
    conn: &mut Connection,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::local_request(conn, "memory.edit", request)
}

pub async fn memory_request(
    path: &Path,
    method: &str,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    crate::memory_bridge::request(path, method, request).await
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
    // A session id held by two stores (a copied store) is listed once, from
    // the store listed first.
    let mut seen = HashSet::new();
    for_each_opencode_store(&readable_opencode_stores(), |store, conn, sessions| {
        sessions
            .generations
            .iter()
            .flat_map(|&generation| {
                list_opencode_sessions_for_generation(conn, store, sessions, generation, filter)
            })
            .collect::<Vec<_>>()
    })
    .into_iter()
    .flatten()
    .filter(|row| seen.insert(row.session_id.clone()))
    .collect()
}

fn list_opencode_sessions_for_generation(
    conn: &Connection,
    store: &ReadableStore,
    sessions: &OpenCodeSessions,
    generation: OpenCodeStoreGeneration,
    filter: &SessionFilter,
) -> Vec<SessionRow> {
    let harness = match generation {
        OpenCodeStoreGeneration::V1 => Harness::Opencode,
        OpenCodeStoreGeneration::V2 => Harness::Opencode2,
    };
    if filter.harness.is_some_and(|wanted| wanted != harness) {
        return Vec::new();
    }
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
    let Ok(mut stmt) = conn.prepare(&format!(
        "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                COALESCE(s.directory, ''), s.time_updated AS last_activity
         FROM {} s
         LEFT JOIN project p ON p.id = s.project_id
         WHERE s.time_archived IS NULL",
        opencode_session_table(generation)
    )) else {
        return Vec::new();
    };

    // Look up the real `is_subagent` flag from Magic Context's session_meta
    // table for this harness. Sessions that have never been touched by the
    // plugin (very rare in practice for OpenCode sessions, since the plugin
    // tags every session on first prompt) default to `false`, matching the
    // "primary session" assumption.
    let subagent_map = load_subagent_map_for_harness(harness);
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
        let identity = lookup_session_identity(&session_identities, harness, &session_id);
        let is_subagent = subagent_map.get(&session_id).copied().unwrap_or(false)
            || store.flags_as_helper(&session_id);
        // Friendly label: the named project wins; otherwise the directory's
        // basename. Never show a bare "/" (the global-project worktree) when the
        // session actually ran in a real directory.
        let project_display = if !project_name.is_empty() {
            project_name
        } else {
            basename(effective_dir)
        };
        Ok(SessionRow {
            harness,
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
            .filter(|row| {
                sessions.owns(&row.session_id, generation) && session_matches_filter(row, filter)
            })
            .collect()
    })
    .unwrap_or_default()
}

fn list_pi_compatible_sessions(
    filter: &SessionFilter,
    harness: Harness,
    sessions: Vec<pi_sessions::PiSessionMeta>,
) -> Vec<SessionRow> {
    if filter.harness.is_some_and(|wanted| wanted != harness) {
        return Vec::new();
    }
    let subagent_map = load_subagent_map_for_harness(harness);
    let session_identities = load_session_identity_map();
    sessions
        .into_iter()
        .map(|meta| {
            let project_identity =
                lookup_session_identity(&session_identities, harness, &meta.session_id);
            let is_subagent = subagent_map.get(&meta.session_id).copied().unwrap_or(false);
            SessionRow {
                harness,
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

pub fn list_pi_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    list_pi_compatible_sessions(filter, Harness::Pi, pi_sessions::scan_pi_session_dir())
}

pub fn list_omp_sessions(filter: &SessionFilter) -> Vec<SessionRow> {
    list_pi_compatible_sessions(filter, Harness::Omp, pi_sessions::scan_omp_session_dir())
}

pub fn list_all_sessions(filter: SessionFilter) -> Vec<SessionRow> {
    let mut rows = Vec::new();
    rows.extend(list_opencode_sessions(&filter));
    rows.extend(list_pi_sessions(&filter));
    rows.extend(list_omp_sessions(&filter));
    rows.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    rows
}

pub fn list_sessions_paged(filter: SessionFilter) -> PagedSessions {
    let include_opencode = filter.harness.map_or(true, |harness| {
        matches!(harness, Harness::Opencode | Harness::Opencode2)
    });
    let rows = list_all_sessions(filter.clone());
    let mut page = page_session_rows(rows, filter.offset, filter.limit);
    if include_opencode {
        let resolution = resolve_opencode_db();
        if resolution.path == Path::new(":memory:") || !resolution.path.exists() {
            page.conditions
                .push(opencode_db_missing_condition(&resolution));
        }
    }
    page
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
        conditions: Vec::new(),
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
///
/// OpenCode 1.x seats that locked the harness to "opencode2" wrote the flag
/// under that label while the host store still lists the session as OpenCode.
/// Match either label so the dashboard filter still sees those rows.
fn load_subagent_map_for_harness(harness: Harness) -> std::collections::HashMap<String, bool> {
    let Some(db_path) = resolve_db_path() else {
        return HashMap::new();
    };
    static CACHE: OnceLock<Mutex<Option<SubagentMapCache>>> = OnceLock::new();
    let Ok(mut guard) = CACHE.get_or_init(|| Mutex::new(None)).lock() else {
        return HashMap::new();
    };
    let file_key = std::fs::metadata(&db_path)
        .ok()
        .as_ref()
        .and_then(file_identity);
    if !guard
        .as_ref()
        .is_some_and(|cache| cache.path == db_path && cache.file_key == file_key)
    {
        *guard = None;
        let Ok(conn) = open_readonly(&db_path) else {
            return HashMap::new();
        };
        *guard = Some(SubagentMapCache {
            path: db_path,
            file_key,
            conn,
            data_version: None,
            computed_at: std::time::Instant::now(),
            maps: HashMap::new(),
        });
    }
    let cache = guard.as_mut().expect("set above");
    let Ok(version) = cache
        .conn
        .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
    else {
        *guard = None;
        return HashMap::new();
    };
    // context.db is written on every Magic Context transform, so its data
    // version moves almost every poll while a session runs. `is_subagent` is
    // set when a session starts and does not change after, so a map up to
    // SUBAGENT_MAP_MAX_AGE old is kept rather than scanning `session_meta`
    // (16 MB on a busy store) once per harness per poll. OpenCode children
    // are also flagged from the OpenCode store's own parent ids, which follow
    // every poll.
    const SUBAGENT_MAP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(10);
    if cache.data_version != Some(version) && cache.computed_at.elapsed() >= SUBAGENT_MAP_MAX_AGE {
        cache.maps.clear();
    }
    if cache.maps.is_empty() {
        cache.data_version = Some(version);
        cache.computed_at = std::time::Instant::now();
    }
    let group = match harness {
        Harness::Opencode | Harness::Opencode2 => Harness::Opencode,
        other => other,
    };
    if !cache.maps.contains_key(&group) {
        let map = load_subagent_map_from_conn(&cache.conn, harness);
        cache.maps.insert(group, map);
    }
    cache.maps.get(&group).cloned().unwrap_or_default()
}

/// `load_subagent_map_for_harness`'s connection to context.db, kept between
/// polls with the maps it last read.
struct SubagentMapCache {
    path: PathBuf,
    file_key: Option<(u64, u64)>,
    conn: Connection,
    data_version: Option<i64>,
    computed_at: std::time::Instant,
    maps: HashMap<Harness, HashMap<String, bool>>,
}

fn load_subagent_map_from_conn(
    conn: &Connection,
    harness: Harness,
) -> std::collections::HashMap<String, bool> {
    use std::collections::HashMap;
    let mut map: HashMap<String, bool> = HashMap::new();
    if matches!(harness, Harness::Opencode | Harness::Opencode2) {
        let Ok(mut stmt) = conn.prepare(
            "SELECT session_id, is_subagent
             FROM session_meta
             WHERE harness IN ('opencode', 'opencode2') AND is_subagent != 0",
        ) else {
            return map;
        };
        if let Ok(rows) = stmt.query_map([], |row| {
            let sid: String = row.get(0)?;
            let flag: i64 = row.get(1)?;
            Ok((sid, flag != 0))
        }) {
            for row in rows.flatten() {
                map.insert(row.0, row.1);
            }
        }
        return map;
    }
    let Ok(mut stmt) = conn.prepare(
        "SELECT session_id, is_subagent
         FROM session_meta
         WHERE harness = ?1 AND is_subagent != 0",
    ) else {
        return map;
    };
    if let Ok(rows) = stmt.query_map([harness.as_str()], |row| {
        let sid: String = row.get(0)?;
        let flag: i64 = row.get(1)?;
        Ok((sid, flag != 0))
    }) {
        for row in rows.flatten() {
            map.insert(row.0, row.1);
        }
    }
    map
}

/// OpenCode writes `session.parent_id` synchronously when it spawns a task
/// child. That column is the host's structural subagent signal and is present
/// even when Magic Context has no `session_meta` row yet (or the row was
/// mislabelled). Empty-string parent_id is treated as primary, matching the
/// plugin fallback. Served from each store's `OpenCodeListCache`, which
/// tracks parents as it follows the session table, instead of a full scan
/// per poll.
///
/// This is also where a store's own helper sessions are added (see
/// `ReadableStore::flags_as_helper`): sessions a runner store says Magic
/// Context owns are flagged like children, in that store only.
fn load_opencode_store_child_session_ids() -> HashSet<String> {
    with_opencode_list_caches(|store, cache| {
        let now = std::time::Instant::now();
        let mut flagged = cache.child_session_ids(now);
        flagged.extend(
            store
                .helper_session_ids()
                .filter(|id| cache.owns(id))
                .map(str::to_string),
        );
        flagged
    })
    .into_iter()
    .flatten()
    .collect()
}

fn mark_opencode_store_children_as_subagents(flags: &mut HashMap<(Harness, String), bool>) {
    for session_id in load_opencode_store_child_session_ids() {
        flags.insert((Harness::Opencode, session_id.clone()), true);
        flags.insert((Harness::Opencode2, session_id), true);
    }
}

pub fn get_session_detail(
    conn: Option<&Connection>,
    harness: Harness,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    match harness {
        Harness::Opencode | Harness::Opencode2 => get_opencode_session_detail(conn, session_id),
        Harness::Pi | Harness::Omp => Ok(get_pi_session_detail(conn, harness, session_id)),
        Harness::ClaudeCode | Harness::Codex | Harness::Broca => Ok(None),
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
        Harness::Opencode | Harness::Opencode2 => {
            Ok(with_opencode_session_store(session_id, |conn, generation| {
                load_opencode_messages(conn, generation, session_id)
            })
            .transpose()?
            .unwrap_or_default())
        }
        Harness::Pi | Harness::Omp => {
            let Some(path) = find_pi_session_path_for_harness(harness, session_id) else {
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
        Harness::ClaudeCode | Harness::Codex | Harness::Broca => Ok(Vec::new()),
    }
}

pub fn get_opencode_session_detail(
    conn: Option<&Connection>,
    session_id: &str,
) -> Result<Option<SessionDetail>, rusqlite::Error> {
    // Read everything this needs from the OpenCode store in one short visit,
    // then close it before reading Magic Context's own store.
    let found = with_opencode_session_store(session_id, |oc_conn, generation| {
        let row = oc_conn.query_row(
            &format!(
                "SELECT s.id, COALESCE(s.title, ''), COALESCE(p.name, ''), COALESCE(p.worktree, ''),
                COALESCE(s.directory, ''),
                COALESCE(json_object('id', s.id, 'title', s.title, 'directory', s.directory), '{{}}')
         FROM {} s LEFT JOIN project p ON p.id = s.project_id WHERE s.id = ?1",
                opencode_session_table(generation)
            ),
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
        let Ok(row) = row else {
            return None;
        };
        // Cheap row counts for badge rendering. Both are O(rows-in-session) at
        // worst but use only INTEGER aggregates (no JSON extraction or part-table
        // join), so they're <20ms even for 37k-message sessions.
        let (message_table, cache_predicate) = match generation {
            OpenCodeStoreGeneration::V1 => (
                "message",
                "json_extract(data, '$.role') = 'assistant' AND COALESCE(CAST(json_extract(data, '$.tokens.total') AS INTEGER), 0) > 0",
            ),
            OpenCodeStoreGeneration::V2 => (
                "session_message",
                "type = 'assistant' AND json_extract(data, '$.tokens') IS NOT NULL",
            ),
        };
        let messages_count_sql =
            format!("SELECT COUNT(*) FROM {message_table} WHERE session_id = ?1");
        let messages_count: i64 = oc_conn
            .query_row(&messages_count_sql, [session_id], |row| row.get(0))
            .unwrap_or(0);
        let cache_events_count_sql = format!(
            "SELECT COUNT(*) FROM {message_table} WHERE session_id = ?1 AND {cache_predicate}"
        );
        let cache_events_count: i64 = oc_conn
            .query_row(&cache_events_count_sql, [session_id], |row| row.get(0))
            .unwrap_or(0);
        Some((row, generation, messages_count, cache_events_count))
    })
    .flatten();
    let Some((row, generation, messages_count, cache_events_count)) = found else {
        return Ok(None);
    };
    let (session_id, title, project_name, worktree, directory, data_json) = row;
    // Prefer s.directory over p.worktree for identity/display: OpenCode buckets
    // git-repo sessions that had no remote/commit at creation under the `global`
    // project (worktree "/"), and the plugin keys identity off session.directory —
    // using worktree here would mis-resolve and show "/". Worktree is the fallback.
    let effective_dir = if directory.is_empty() {
        worktree.clone()
    } else {
        directory
    };
    let harness = opencode_generation_harness(generation);

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
    let historian_runs = conn
        .map(|c| count_historian_runs(c, &session_id))
        .unwrap_or(0);
    let token_breakdown = conn
        .map(|c| get_context_token_breakdown(c, &session_id))
        .transpose()?
        .flatten();

    let session_identities = load_session_identity_map();
    let project_identity = lookup_session_identity(&session_identities, harness, &session_id);

    Ok(Some(SessionDetail {
        harness,
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
        historian_runs,
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
    generation: OpenCodeStoreGeneration,
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
    let sql = match generation {
        OpenCodeStoreGeneration::V1 => {
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
             ORDER BY m.time_created ASC"
        }
        OpenCodeStoreGeneration::V2 => {
            "SELECT
                CAST(m.id AS TEXT),
                m.time_created,
                CASE WHEN m.type = 'assistant' THEN 'assistant' ELSE 'user' END,
                m.data,
                '' AS aggregated_text
             FROM session_message m
             WHERE m.session_id = ?1
               AND m.type NOT IN ('idle', 'agent-switched', 'model-switched', 'location-switched')
             ORDER BY m.seq ASC"
        }
    };
    let mut stmt = conn.prepare(sql)?;
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

fn find_pi_session_path_for_harness(
    harness: Harness,
    session_id: &str,
) -> Option<std::path::PathBuf> {
    let sessions = match harness {
        Harness::Pi => pi_sessions::scan_pi_session_dir(),
        Harness::Omp => pi_sessions::scan_omp_session_dir(),
        _ => return None,
    };
    sessions
        .into_iter()
        .find(|meta| meta.session_id == session_id)
        .map(|meta| meta.jsonl_path)
}

pub fn get_pi_session_detail(
    conn: Option<&Connection>,
    harness: Harness,
    session_id: &str,
) -> Option<SessionDetail> {
    let path = find_pi_session_path_for_harness(harness, session_id)?;
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

    let mut compartments = conn
        .and_then(|c| get_compartments(c, session_id).ok())
        .unwrap_or_default();
    let boundary_ids: Vec<String> = compartments
        .iter()
        .flat_map(|compartment| {
            [
                compartment.start_message_id.as_deref(),
                compartment.end_message_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            .map(str::to_owned)
        })
        .collect();
    let entry_times = pi_sessions::read_pi_entry_times(&path, &boundary_ids);
    for compartment in &mut compartments {
        compartment.start_time = compartment
            .start_message_id
            .as_ref()
            .and_then(|id| entry_times.get(id).copied());
        compartment.end_time = compartment
            .end_message_id
            .as_ref()
            .and_then(|id| entry_times.get(id).copied());
    }
    let facts = conn
        .and_then(|c| get_session_facts(c, session_id).ok())
        .unwrap_or_default();
    let notes = conn
        .and_then(|c| get_session_notes(c, session_id).ok())
        .unwrap_or_default();
    let meta = conn
        .and_then(|c| get_session_meta(c, session_id).ok())
        .flatten();
    let historian_runs = conn
        .map(|c| count_historian_runs(c, session_id))
        .unwrap_or(0);
    let token_breakdown = conn
        .and_then(|c| get_context_token_breakdown(c, session_id).ok())
        .flatten();
    let session_identities = load_session_identity_map();
    let project_identity = lookup_session_identity(&session_identities, harness, session_id);
    Some(SessionDetail {
        harness,
        session_id: detail.meta.session_id.clone(),
        title,
        project_identity,
        project_display: basename(&detail.meta.cwd),
        project_path: (!detail.meta.cwd.is_empty()).then_some(detail.meta.cwd.clone()),
        opencode_session_json: None,
        pi_jsonl_path: Some(detail.meta.jsonl_path.to_string_lossy().to_string()),
        messages_count,
        cache_events_count,
        historian_runs,
        compartments,
        facts,
        notes,
        meta,
        token_breakdown,
        pi_compaction_entries: detail.compaction_entries.clone(),
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

    let session_identities = load_session_identity_map();
    for_each_opencode_store(&readable_opencode_stores(), |_, conn, resolved| {
        for &generation in &resolved.generations {
            let Ok(mut stmt) = conn.prepare(&format!(
                "SELECT s.id, COALESCE(s.title, '') FROM {} s",
                opencode_session_table(generation)
            )) else {
                continue;
            };
            let harness = opencode_generation_harness(generation);
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for (session_id, title) in rows.flatten() {
                    if !resolved.owns(&session_id, generation) || result.contains_key(&session_id) {
                        continue;
                    }
                    let identity =
                        lookup_session_identity(&session_identities, harness, &session_id);
                    result.insert(session_id, (title, identity));
                }
            };
        }
    });

    result
}

pub fn get_compartments(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Compartment>, rusqlite::Error> {
    let rust_watermark = if crate::db_capabilities::get(conn)?.compartment_scores {
        compartment_scores::rust_watermark(conn, session_id)?
    } else {
        None
    };
    let tx = conn.unchecked_transaction()?;
    let scores = compartment_scores::read(&tx, session_id, rust_watermark)?;
    // v2 tiered compartments: read the paraphrase tiers (p1–p4), the
    // decay-rate `importance`, and `episode_type` directly off the row.
    // `legacy=1` rows predate the tiered format (p1–p4 NULL) and render
    // degraded on the frontend. `content` mirrors p1 for v2 rows.
    let mut stmt = tx.prepare(
        "SELECT c.id, c.session_id, c.sequence, c.start_message, c.end_message,
                c.start_message_id, c.end_message_id, c.title, c.content, c.created_at,
                c.importance, c.episode_type, c.p1, c.p2, c.p3, c.p4, c.legacy
         FROM compartments c
         WHERE c.session_id = ?1
         ORDER BY c.sequence DESC",
    )?;
    let mut compartments: Vec<Compartment> = stmt
        .query_map(rusqlite::params![session_id], |row| {
            let id: i64 = row.get(0)?;
            let base = row.get::<_, Option<i64>>(10)?.unwrap_or(50);
            let selected = scores.selected.contains(&id);
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
                effective_importance: selected
                    .then(|| scores.effective.get(&id).copied().unwrap_or(base)),
                applied_importance: selected
                    .then(|| scores.applied.get(&id).copied().unwrap_or(base)),
                rust_applied_importance: scores
                    .rust_applied
                    .as_ref()
                    .and_then(|view| selected.then(|| view.get(&id).copied().unwrap_or(base))),
                episode_type: row.get(11)?,
                p1: row.get(12)?,
                p2: row.get(13)?,
                p3: row.get(14)?,
                p4: row.get(15)?,
                legacy: row.get::<_, Option<i64>>(16)?.unwrap_or(0),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    tx.commit()?;

    // Resolve message timestamps from the OpenCode store that holds the session.
    let times = with_opencode_session_store(session_id, |oc_conn, generation| {
        let message_table = match generation {
            OpenCodeStoreGeneration::V1 => "message",
            OpenCodeStoreGeneration::V2 => "session_message",
        };
        let timestamp_sql = format!("SELECT time_created FROM {message_table} WHERE id = ?1");
        let time_of = |id: &Option<String>| {
            id.as_ref().and_then(|id| {
                oc_conn
                    .query_row(&timestamp_sql, rusqlite::params![id], |row| {
                        row.get::<_, Option<i64>>(0)
                    })
                    .ok()
            })
        };
        compartments
            .iter()
            .map(|comp| {
                (
                    time_of(&comp.start_message_id),
                    time_of(&comp.end_message_id),
                )
            })
            .collect::<Vec<_>>()
    });
    if let Some(times) = times {
        for (comp, (start, end)) in compartments.iter_mut().zip(times) {
            if let Some(start) = start {
                comp.start_time = start;
            }
            if let Some(end) = end {
                comp.end_time = end;
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
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
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
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
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
    crate::writer_diagnostics::statement("update_note", || {
        conn.execute(
            "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![content, chrono::Utc::now().timestamp_millis(), note_id],
        )
    })
}

pub fn delete_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    crate::writer_diagnostics::statement("delete_note", || {
        conn.execute(
            "DELETE FROM notes WHERE id = ?1",
            rusqlite::params![note_id],
        )
    })
}

pub fn dismiss_note(conn: &Connection, note_id: i64) -> Result<usize, rusqlite::Error> {
    crate::writer_diagnostics::statement("dismiss_note", || {
        conn.execute(
            "UPDATE notes SET status = 'dismissed', updated_at = ?1 WHERE id = ?2",
            rusqlite::params![chrono::Utc::now().timestamp_millis(), note_id],
        )
    })
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
                compartment_in_progress, system_prompt_hash,
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
            compartment_in_progress: row.get::<_, i64>(9)? != 0,
            system_prompt_hash: row.get(10)?,
            memory_block_count: row.get(11)?,
            new_work_tokens: row.get(12)?,
            total_input_tokens: row.get(13)?,
        })
    })?;
    match rows.next() {
        Some(Ok(row)) => Ok(Some(row)),
        Some(Err(e)) => Err(e),
        None => Ok(None),
    }
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
    let global_schedules = crate::jsonc::read_dreamer_task_schedules(
        &crate::config::resolve_user_config_path(&crate::config::config_home()),
    );

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
                .filter(|&&task| {
                    crate::jsonc::startup_smart_notes_enabled() || task != "evaluate-smart-notes"
                })
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
    let sql = format!(
        "SELECT id, origin_category, content, status FROM memories
          WHERE level = 'project' AND id IN ({placeholders})"
    );
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
    crate::db_capabilities::require_memory_store(conn)?;
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
        "SELECT id, origin_category, content, status, created_at, updated_at, superseded_by_memory_id
           FROM memories
          WHERE level = 'project' AND owner_id IN ({placeholders})
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
//
// Since ck-mc's migration 106 a user memory is a global memory: a `memories`
// row at the `global` level, owned by the person, in a reserved category and
// written under the `USER_MEMORY` tag. A candidate is a pending observation.
// The screens write these rows the way that migration shapes them. Sessions
// pick up a changed profile on their own: ck-mc compares the profile lines it
// last put in a prompt with the store.

/// The owner of every user memory: the person.
const USER_MEMORY_OWNER: &str = "self";
/// The reserved category the migration files user memories under.
const USER_MEMORY_CATEGORY: &str = "mc:user-unsorted";
/// The tag a user memory keeps as the category it was written under.
const USER_MEMORY_TAG: &str = "USER_MEMORY";
/// The id the user-memory screens show and act on. A user memory the
/// migration moved keeps its old id in `metadata_json`, and so does the
/// profile ck-mc puts in a session's prompt; a newer one has only its row id.
const USER_MEMORY_ID: &str = "COALESCE(json_extract(metadata_json, '$.user_memory_id'), id)";
/// When a user memory joined the profile: the time the migration kept for a
/// moved one, otherwise when the row was written, as ck-mc orders the profile.
const USER_MEMORY_PROMOTED_AT: &str =
    "COALESCE(json_extract(metadata_json, '$.promoted_at'), created_at)";

fn user_memory_refusal(message: String) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
        Some(message),
    )
}

/// The row behind the user-memory id the screens show, or `None` when no user
/// memory has it.
fn user_memory_row(conn: &Connection, shown_id: i64) -> Result<Option<i64>, rusqlite::Error> {
    let rows: Vec<i64> = conn
        .prepare(&format!(
            "SELECT id FROM memories WHERE level = 'global' AND {USER_MEMORY_ID} = ?1"
        ))?
        .query_map([shown_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(*row)),
        _ => Err(user_memory_refusal(format!(
            "More than one user memory has id #{shown_id}, so the dashboard can't tell which one to change."
        ))),
    }
}

/// Refuse a change that would make `content` a second live user memory: the
/// store keeps one live memory per owner, category and text.
fn refuse_second_live_user_memory(
    conn: &Connection,
    hash: &str,
    except_row: Option<i64>,
) -> Result<(), rusqlite::Error> {
    let existing: Option<i64> = conn
        .query_row(
            &format!(
                "SELECT {USER_MEMORY_ID} FROM memories
                  WHERE level = 'global' AND owner_id = ?1 AND category = ?2
                    AND normalized_hash = ?3 AND id IS NOT ?4
                    AND (status IS NULL OR status IN ('active', 'permanent'))
                  LIMIT 1"
            ),
            params![USER_MEMORY_OWNER, USER_MEMORY_CATEGORY, hash, except_row],
            |row| row.get(0),
        )
        .optional()?;
    match existing {
        Some(existing) => Err(user_memory_refusal(format!(
            "User memory #{existing} already says this; dismiss or delete it first."
        ))),
        None => Ok(()),
    }
}

pub fn get_user_memories(
    conn: &Connection,
    status_filter: Option<&str>,
) -> Result<Vec<UserMemory>, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let mut conditions = vec!["level = 'global'".to_string()];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(s) = status_filter {
        params.push(Box::new(s.to_string()));
        conditions.push(format!("status = ?{}", params.len()));
    }

    // Newest first; user memories written in the same millisecond keep the
    // order of their ids, as the old table's scan returned them.
    let sql = format!(
        "SELECT {USER_MEMORY_ID}, content, status, {USER_MEMORY_PROMOTED_AT},
                json_extract(metadata_json, '$.source_candidate_ids'), created_at, updated_at
         FROM memories
         WHERE {}
         ORDER BY created_at DESC, {USER_MEMORY_ID} ASC",
        conditions.join(" AND ")
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        // The migration keeps parsed candidate ids as JSON and an unparsable
        // value as text, which the screen showed as no candidates.
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

/// Pending observations about the person: the candidates the screen can
/// promote to user memories or delete.
pub fn get_user_memory_candidates(
    conn: &Connection,
) -> Result<Vec<UserMemoryCandidate>, rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, content, session_id, source_start_ordinal, source_end_ordinal, created_at
         FROM memory_observations
         WHERE consumed_at IS NULL
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
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    // A repeat dismiss must not rewrite the timestamp or the revision.
    if let Some(row) = user_memory_row(&tx, id)? {
        tx.execute(
            "UPDATE memories SET status = 'dismissed', updated_at = ?1, revision = revision + 1
              WHERE id = ?2 AND status = 'active'",
            params![now_millis(), row],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn restore_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    // The status predicate makes restoring an active memory a no-op.
    let dismissed: Option<(i64, String)> = match user_memory_row(&tx, id)? {
        Some(row) => tx
            .query_row(
                "SELECT id, normalized_hash FROM memories WHERE id = ?1 AND status = 'dismissed'",
                params![row],
                |found| Ok((found.get(0)?, found.get(1)?)),
            )
            .optional()?,
        None => None,
    };
    if let Some((row, hash)) = dismissed {
        refuse_second_live_user_memory(&tx, &hash, Some(row))?;
        tx.execute(
            "UPDATE memories SET status = 'active', updated_at = ?1, revision = revision + 1
              WHERE id = ?2",
            params![now_millis(), row],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory(conn: &mut Connection, id: i64) -> Result<(), rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    if let Some(row) = user_memory_row(&tx, id)? {
        tx.execute("DELETE FROM memories WHERE id = ?1", params![row])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn update_user_memory_content(
    conn: &mut Connection,
    id: i64,
    content: &str,
) -> Result<(), rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;
    if let Some(row) = user_memory_row(&tx, id)? {
        let live: bool = tx.query_row(
            "SELECT status IS NULL OR status IN ('active', 'permanent') FROM memories WHERE id = ?1",
            params![row],
            |found| found.get(0),
        )?;
        // The text is the row's unique key, so its hash changes with it.
        let hash = crate::memory_history::normalized_hash(content);
        if live {
            refuse_second_live_user_memory(&tx, &hash, Some(row))?;
        }
        tx.execute(
            "UPDATE memories SET content = ?1, normalized_hash = ?2, updated_at = ?3,
                    revision = revision + 1
              WHERE id = ?4",
            params![content, hash, now_millis(), row],
        )?;
        // A vector computed for the old text no longer describes the row.
        tx.execute(
            "DELETE FROM memory_embeddings WHERE memory_id = ?1",
            params![row],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_user_memory_candidate(conn: &Connection, id: i64) -> Result<(), rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    crate::writer_diagnostics::statement("delete_user_memory_candidate", || {
        conn.execute("DELETE FROM memory_observations WHERE id = ?1", params![id])
    })?;
    Ok(())
}

/// Promote a candidate to an active user memory, filed the way ck-mc's
/// migration 106 files the user memories it moves.
pub fn promote_user_memory_candidate(
    conn: &mut Connection,
    id: i64,
) -> Result<(), rusqlite::Error> {
    crate::db_capabilities::require_memory_store_sql(conn)?;
    let now = now_millis();
    let tx = crate::writer_diagnostics::begin(conn, concat!(file!(), ":", line!()))?;

    let content: String = tx.query_row(
        "SELECT content FROM memory_observations WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    let hash = crate::memory_history::normalized_hash(&content);
    refuse_second_live_user_memory(&tx, &hash, None)?;

    let metadata = serde_json::json!({ "promoted_at": now, "source_candidate_ids": [id] });
    tx.execute(
        "INSERT INTO memories (level, owner_id, category, origin_category, content,
             normalized_hash, source_type, seen_count, retrieval_count, first_seen_at,
             created_at, updated_at, last_seen_at, status, metadata_json)
         VALUES ('global', ?1, ?2, ?3, ?4, ?5, 'user-review', 1, 0, ?6, ?6, ?6, ?6, 'active', ?7)",
        params![
            USER_MEMORY_OWNER,
            USER_MEMORY_CATEGORY,
            USER_MEMORY_TAG,
            content,
            hash,
            now,
            metadata.to_string()
        ],
    )?;
    tx.execute("DELETE FROM memory_observations WHERE id = ?1", params![id])?;

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
        let sql = recent_opencode_cache_sessions_sql(
            OpenCodeStoreGeneration::V1,
            OpenCodeCacheActivity::SessionRow,
        )
        .to_ascii_lowercase();
        assert!(sql.contains("from session"));
        assert!(recent_opencode_cache_sessions_sql(
            OpenCodeStoreGeneration::V2,
            OpenCodeCacheActivity::SessionRow,
        )
        .to_ascii_lowercase()
        .contains("from session_v2"));
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

        let sessions = load_recent_opencode_cache_sessions_from_conn(
            &conn,
            OpenCodeStoreGeneration::V1,
            1,
            &HashSet::new(),
        );

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

        let sessions = load_recent_opencode_cache_sessions_from_conn(
            &conn,
            OpenCodeStoreGeneration::V1,
            1,
            &HashSet::new(),
        );

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

        let sessions = load_recent_opencode_cache_sessions_from_conn(
            &conn,
            OpenCodeStoreGeneration::V1,
            1,
            &hidden,
        );

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "primary");
    }

    /// The two tables the Cache tab list reads, exactly as a real OpenCode
    /// 2.0.15 host created them (read back from `sqlite_master` of a store the
    /// pinned CLI wrote), with the indexes it put on `session_message`.
    const OPENCODE2_0_15_SCHEMA: &str = "
        CREATE TABLE `session_v2` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `fork_session_id` text,
          `fork_boundary` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_idle` integer,
          `time_viewed` integer,
          `idle_outcome` text,
          `time_compacting` integer,
          `time_archived` integer,
          `time_suspended` integer,
          `resume_attempts` integer DEFAULT 0 NOT NULL
        );
        CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_v2_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
        CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
        CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
        CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
    ";

    fn opencode2_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open OpenCode 2 DB");
        conn.execute_batch(OPENCODE2_0_15_SCHEMA)
            .expect("create OpenCode 2.0.15 schema");
        conn
    }

    fn insert_v2_session(conn: &Connection, id: &str, updated: i64) {
        conn.execute(
            "INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
             VALUES (?1, 'project', ?1, '/work', '2.0.15', 1, ?2)",
            params![id, updated],
        )
        .expect("insert session_v2");
    }

    /// An assistant row whose tokens make it a cache event; `updated` is the
    /// row's `time_updated`, which the host rewrites as the step streams in.
    fn insert_v2_assistant(
        conn: &Connection,
        session_id: &str,
        seq: i64,
        created: i64,
        updated: i64,
    ) {
        conn.execute(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
             VALUES (?1, ?2, 'assistant', ?3, ?4, ?5, ?6)",
            params![
                format!("{session_id}-{seq}"),
                session_id,
                seq,
                created,
                updated,
                serde_json::json!({ "tokens": { "input": 10, "output": 5 } }).to_string(),
            ],
        )
        .expect("insert session_message");
    }

    // Timeline observed on a real OpenCode 2.0.15 host during a multi-step
    // turn: session_v2.time_updated stayed at the prompt time while each
    // step's assistant row, the newest by seq, kept being rewritten.
    #[test]
    fn opencode2_list_dates_a_live_turn_by_its_newest_message_row() {
        let conn = opencode2_db();
        insert_v2_session(&conn, "live", 1_000);
        insert_v2_assistant(&conn, "live", 6, 1_100, 2_500);
        insert_v2_assistant(&conn, "live", 14, 2_600, 5_000);
        insert_v2_session(&conn, "idle", 3_000);
        insert_v2_assistant(&conn, "idle", 4, 2_900, 3_000);
        // No message yet: the session row's own time still dates it.
        insert_v2_session(&conn, "fresh", 4_000);

        assert_eq!(
            opencode_cache_activity(&conn, OpenCodeStoreGeneration::V2),
            OpenCodeCacheActivity::NewestMessage
        );
        assert_eq!(
            opencode_cache_activity_note(&conn, OpenCodeStoreGeneration::V2),
            None
        );

        let sessions = load_recent_opencode_cache_sessions_from_conn(
            &conn,
            OpenCodeStoreGeneration::V2,
            10,
            &HashSet::new(),
        );
        let listed: Vec<(&str, i64)> = sessions
            .iter()
            .map(|row| (row.session_id.as_str(), row.last_activity_ms))
            .collect();
        assert_eq!(listed, vec![("live", 5_000), ("idle", 3_000)]);
        assert!(sessions.iter().all(|row| row.harness == Harness::Opencode2));
    }

    // Every poll runs this query, so it must reach each session's newest row
    // through the (session_id, seq) index instead of reading every message.
    #[test]
    fn opencode2_list_query_seeks_the_session_seq_index() {
        let conn = opencode2_db();
        let sql = recent_opencode_cache_sessions_sql(
            OpenCodeStoreGeneration::V2,
            OpenCodeCacheActivity::NewestMessage,
        );
        let mut stmt = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("plan the OpenCode 2 list query");
        let plan: Vec<String> = stmt
            .query_map(params![10_i64, 0_i64], |row| row.get::<_, String>(3))
            .expect("read the plan")
            .flatten()
            .collect();
        let message_steps: Vec<&String> = plan
            .iter()
            .filter(|step| {
                step.contains(" m ") || step.ends_with(" m") || step.contains("session_message")
            })
            .collect();
        assert!(
            !message_steps.is_empty()
                && message_steps.iter().all(|step| {
                    step.starts_with("SEARCH") && step.contains("session_message_session_seq_idx")
                }),
            "session_message must only be reached by an index seek: {plan:?}"
        );
        assert!(
            !plan.iter().any(|step| step.contains("GROUP BY")),
            "the list query must not group message rows: {plan:?}"
        );
    }

    // A store whose session_message has no time_updated column still lists
    // its sessions by the session row's time, and says why they stay still.
    #[test]
    fn opencode2_store_without_message_time_updated_lists_sessions_and_notes_it() {
        let conn = Connection::open_in_memory().expect("open OpenCode 2 DB");
        conn.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                title TEXT,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            INSERT INTO session_v2 VALUES ('ses', NULL, 1000, NULL);
            INSERT INTO session_message VALUES ('m1', 'ses', 'assistant', 1, 900, '{\"tokens\":{}}');",
        )
        .expect("create OpenCode 2 store without message time_updated");

        assert_eq!(
            opencode_cache_activity(&conn, OpenCodeStoreGeneration::V2),
            OpenCodeCacheActivity::SessionRow
        );
        assert_eq!(
            opencode_cache_activity_note(&conn, OpenCodeStoreGeneration::V2),
            Some(OPENCODE2_ACTIVITY_FALLBACK_NOTE)
        );
        let sessions = load_recent_opencode_cache_sessions_from_conn(
            &conn,
            OpenCodeStoreGeneration::V2,
            10,
            &HashSet::new(),
        );
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "ses");
        assert_eq!(sessions[0].last_activity_ms, 1000);
    }

    // Measures the list query on a synthetic store with the real 2.0.15
    // schema. Run with:
    // cargo test --lib opencode2_list_query_benchmark -- --ignored --nocapture
    #[test]
    #[ignore]
    fn opencode2_list_query_benchmark() {
        for (sessions, per_session) in [(3_000_i64, 100_i64), (10_000, 100)] {
            let conn = opencode2_db();
            conn.execute_batch("BEGIN").unwrap();
            {
                let mut session = conn
                    .prepare(
                        "INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated)
                         VALUES (?1, 'p', ?1, '/w', '2.0.15', 1, ?2)",
                    )
                    .unwrap();
                let mut message = conn
                    .prepare(
                        "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
                         VALUES (?1, ?2, 'assistant', ?3, ?4, ?4, '{\"tokens\":{}}')",
                    )
                    .unwrap();
                for s in 0..sessions {
                    let id = format!("ses-{s:06}");
                    session.execute(params![id, s * 1_000]).unwrap();
                    for seq in 0..per_session {
                        message
                            .execute(params![format!("{id}-{seq}"), id, seq, s * 1_000 + seq])
                            .unwrap();
                    }
                }
            }
            conn.execute_batch("COMMIT; ANALYZE;").unwrap();
            let sql = recent_opencode_cache_sessions_sql(
                OpenCodeStoreGeneration::V2,
                OpenCodeCacheActivity::NewestMessage,
            );
            let mut stmt = conn.prepare(&sql).unwrap();
            let runs = 20;
            let start = std::time::Instant::now();
            for _ in 0..runs {
                let rows: Vec<String> = stmt
                    .query_map(params![200_i64, 0_i64], |row| row.get(0))
                    .unwrap()
                    .flatten()
                    .collect();
                assert_eq!(rows.len(), 200);
            }
            let per_poll = start.elapsed().as_secs_f64() * 1_000.0 / f64::from(runs);
            println!(
                "{sessions} sessions, {} messages: {per_poll:.2} ms per list query",
                sessions * per_session
            );
        }
    }
}

#[cfg(test)]
mod opencode_parent_id_subagent_hide_tests {
    use super::*;
    use rusqlite::{params, Connection};
    use std::fs;

    fn insert_cache_message(conn: &Connection, id: &str, session_id: &str, time: i64) {
        let data = serde_json::json!({
            "role": "assistant",
            "tokens": { "input": 10, "cache": { "read": 80, "write": 10 }, "total": 100 }
        })
        .to_string();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
            params![id, session_id, time, data],
        )
        .unwrap();
    }

    #[test]
    fn hide_subagents_uses_opencode_parent_id_when_session_meta_is_missing() {
        let mut env = crate::test_env::EnvGuard::new();
        let root = tempfile::tempdir().unwrap();
        let storage = root.path().join("mc");
        fs::create_dir_all(&storage).unwrap();
        let context_db = storage.join("context.db");
        Connection::open(&context_db)
            .unwrap()
            .execute_batch(
                "CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    is_subagent INTEGER DEFAULT 0
                );",
            )
            .unwrap();

        let opencode_db = root.path().join("opencode.db");
        let oc = Connection::open(&opencode_db).unwrap();
        oc.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER,
                parent_id TEXT
            );
            CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .unwrap();
        oc.execute(
            "INSERT INTO session (id, title, time_updated, time_archived, parent_id)
             VALUES ('ses-primary', 'primary', 200, NULL, NULL)",
            [],
        )
        .unwrap();
        oc.execute(
            "INSERT INTO session (id, title, time_updated, time_archived, parent_id)
             VALUES ('ses-child', 'child', 300, NULL, 'ses-primary')",
            [],
        )
        .unwrap();
        insert_cache_message(&oc, "m-primary", "ses-primary", 200);
        insert_cache_message(&oc, "m-child", "ses-child", 300);

        env.set("MAGIC_CONTEXT_STORAGE_DIR", &storage);
        env.set("XDG_DATA_HOME", root.path());
        env.set("OPENCODE_DB", &opencode_db);
        assert!(resolve_db_path().unwrap().starts_with(root.path()));

        let stats = get_session_cache_stats_from_db(10, true, true, Some(Harness::Opencode));
        let ids: Vec<&str> = stats.iter().map(|row| row.session_id.as_str()).collect();
        assert!(
            ids.contains(&"ses-primary"),
            "primary session should remain visible: {ids:?}",
        );
        assert!(
            !ids.contains(&"ses-child"),
            "child with parent_id and no session_meta row must still be hidden: {ids:?}",
        );
    }

    // The Cache tab's "OpenCode 2" filter must list an OpenCode 2 store's
    // sessions, and the "OpenCode" filter must not list them.
    #[test]
    fn opencode2_harness_filter_lists_opencode2_store_sessions() {
        let mut env = crate::test_env::EnvGuard::new();
        let root = tempfile::tempdir().unwrap();
        let storage = root.path().join("mc");
        fs::create_dir_all(&storage).unwrap();
        Connection::open(storage.join("context.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE session_meta (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    is_subagent INTEGER DEFAULT 0
                );",
            )
            .unwrap();
        let opencode_db = root.path().join("opencode.db");
        let oc = Connection::open(&opencode_db).unwrap();
        oc.execute_batch(
            "CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                title TEXT,
                parent_id TEXT,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                data TEXT NOT NULL
            );
            CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
            INSERT INTO session_v2 VALUES ('ses-v2', 'v2 session', NULL, 100, NULL);
            INSERT INTO session_message VALUES
                ('m1', 'ses-v2', 'assistant', 1, 110, 400, '{\"tokens\":{\"input\":10}}');",
        )
        .unwrap();

        env.set("MAGIC_CONTEXT_STORAGE_DIR", &storage);
        env.set("XDG_DATA_HOME", root.path());
        env.set("OPENCODE_DB", &opencode_db);

        let stats = get_session_cache_stats_from_db(10, true, false, Some(Harness::Opencode2));
        let listed: Vec<(Harness, &str, i64)> = stats
            .iter()
            .map(|row| (row.harness, row.session_id.as_str(), row.last_activity_ms))
            .collect();
        assert_eq!(listed, vec![(Harness::Opencode2, "ses-v2", 400)]);
        assert_eq!(stats[0].activity_note, None);

        let v1_only = get_session_cache_stats_from_db(10, true, false, Some(Harness::Opencode));
        assert!(
            v1_only.iter().all(|row| row.harness != Harness::Opencode2),
            "the OpenCode filter must not list OpenCode 2 sessions: {v1_only:?}"
        );
    }
}

#[cfg(test)]
mod session_history_slice_tests {
    use super::{extract_new_compartments_slice, extract_session_history_slice};

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
    fn m1_compartments_are_counted_when_m0_history_is_empty() {
        let m0 = "<session-history>\n</session-history>";
        let m1 = "<session-history-since>\n<new-compartments>\n## 11-14 · Continued\nnew material\n</new-compartments>\n</session-history-since>";
        let m0_chars = extract_session_history_slice(m0).unwrap().len() as i64;
        let m1_chars = extract_new_compartments_slice(m1).unwrap().len() as i64;

        // Through the real breakdown: a session whose m[0] was built before any
        // compartment existed serves every compartment from m[1], and the bucket
        // must count them there (issue 515's miscount showed a constant ~9 tokens).
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (session_id TEXT, last_input_tokens INTEGER,
                 system_prompt_tokens INTEGER, cached_m0_bytes BLOB, cached_m1_bytes BLOB,
                 memory_block_cache TEXT, memory_block_count INTEGER);
             CREATE TABLE compartments (session_id TEXT, title TEXT, content TEXT);
             CREATE TABLE session_facts (session_id TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta VALUES ('s', 50000, 1000, ?1, ?2, NULL, 0)",
            rusqlite::params![m0.as_bytes(), m1.as_bytes()],
        )
        .unwrap();
        let breakdown = super::get_context_token_breakdown(&conn, "s")
            .unwrap()
            .expect("breakdown for a session with recorded input");
        assert_eq!(
            breakdown.compartment_tokens,
            super::estimate_tokens(m0_chars) + super::estimate_tokens(m1_chars)
        );
        assert!(breakdown.compartment_tokens > super::estimate_tokens(m0_chars));
    }

    #[test]
    fn separated_render_payloads_preserve_buckets_and_clear_all() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (session_id TEXT, last_input_tokens INTEGER,
                 system_prompt_tokens INTEGER, memory_block_count INTEGER,
                 memory_block_ids TEXT DEFAULT '', cached_m0_max_memory_mutation_id INTEGER);
             INSERT INTO session_meta VALUES ('s', 50000, 1000, 1, '[1]', 2);
             CREATE TABLE session_render_cache (session_id TEXT, cache_key TEXT, value BLOB);
             CREATE TABLE compartments (session_id TEXT, title TEXT, content TEXT);
             CREATE TABLE session_facts (session_id TEXT);",
        )
        .unwrap();
        let m0 = "<session-history>stable history</session-history>";
        let m1 = "<session-history-since><new-compartments>new history</new-compartments></session-history-since>";
        for (key, bytes) in [
            ("cached_m0_bytes", m0.as_bytes()),
            ("cached_m1_bytes", m1.as_bytes()),
        ] {
            conn.execute(
                "INSERT INTO session_render_cache VALUES ('s', ?1, ?2)",
                rusqlite::params![key, bytes],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO session_render_cache VALUES ('s', 'memory_block_cache', '<project-memory>remember</project-memory>')", []).unwrap();
        conn.execute(
            "INSERT INTO session_render_cache VALUES ('s', 'cached_m0_mural_data_url', 'image')",
            [],
        )
        .unwrap();
        let breakdown = super::get_context_token_breakdown(&conn, "s")
            .unwrap()
            .unwrap();
        assert_eq!(
            breakdown.compartment_tokens,
            super::estimate_tokens(extract_session_history_slice(m0).unwrap().len() as i64)
                + super::estimate_tokens(extract_new_compartments_slice(m1).unwrap().len() as i64)
        );
        assert_eq!(
            breakdown.memory_tokens,
            super::estimate_tokens("<project-memory>remember</project-memory>".len() as i64)
        );
        assert_eq!(super::invalidate_all_memory_block_caches(&conn).unwrap(), 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM session_render_cache", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(super::invalidate_all_memory_block_caches(&conn).unwrap(), 0);
    }

    #[test]
    fn normalized_manifest_clear_preserves_null_rows_and_the_callers_transaction() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, cached_m0_max_memory_mutation_id INTEGER);
            INSERT INTO session_meta VALUES ('changed',NULL),('null-only',NULL);
            CREATE TABLE session_render_cache(session_id TEXT,cache_key TEXT,value BLOB);
            INSERT INTO session_render_cache VALUES ('changed','cached_m0_mural_data_url','keep'),('null-only','memory_block_cache',NULL);
            CREATE TABLE session_meta_chunks(session_id TEXT,column_name TEXT,chunk TEXT,body BLOB);
            INSERT INTO session_meta_chunks VALUES ('changed','memory_block_ids','-1',X''),('changed','memory_block_ids','0',CAST('[1]' AS BLOB));
            BEGIN IMMEDIATE;").unwrap();
        assert_eq!(super::invalidate_all_memory_block_caches(&conn).unwrap(), 1);
        assert!(!conn.is_autocommit());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM session_meta_chunks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM session_meta_chunks", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(super::invalidate_all_memory_block_caches(&conn).unwrap(), 1);
        assert_eq!(super::invalidate_all_memory_block_caches(&conn).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM session_render_cache WHERE session_id='null-only' AND value IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM session_render_cache WHERE cache_key='cached_m0_mural_data_url'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
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
        let mut env = crate::test_env::EnvGuard::new();
        let data_home = tempfile::tempdir().expect("data home");
        let pi_root = tempfile::tempdir().expect("pi root");
        env.set("XDG_DATA_HOME", data_home.path());
        env.remove("MAGIC_CONTEXT_STORAGE_DIR");
        env.remove("OPENCODE_DB");
        env.remove("OPENCODE_CHANNEL");
        env.remove("OPENCODE_DISABLE_CHANNEL_DB");
        assert_eq!(super::data_home(), data_home.path());
        assert!(resolve_db_path().map_or(true, |path| path.starts_with(data_home.path())));
        crate::pi_sessions::clear_caches_for_tests();
        crate::pi_sessions::set_test_root_for_tests(pi_root.path().to_path_buf());

        let result = run(data_home.path());

        crate::pi_sessions::clear_caches_for_tests();
        result
    }

    fn create_context_db(data_home: &Path, with_session_projects: bool) -> Connection {
        let path = context_db_path(data_home);
        std::fs::create_dir_all(path.parent().expect("context parent")).expect("context dirs");
        super::schema_fixture::create_test_context_db(&path);
        let conn = Connection::open(&path).expect("open context db");
        if !with_session_projects {
            conn.execute_batch("DROP TABLE session_projects;")
                .expect("drop session_projects");
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

    /// Tables of a fresh OpenCode 2 store as far as the dashboard reads them:
    /// sessions live in `session_v2`, and there is no `session`, `message` or
    /// `part` table (captured from a real OpenCode 2.0.18 host).
    fn create_opencode2_db(data_home: &Path) -> Connection {
        let path = opencode_db_path(data_home);
        std::fs::create_dir_all(path.parent().expect("opencode parent")).expect("opencode dirs");
        let conn = Connection::open(&path).expect("open opencode db");
        conn.execute_batch(
            "CREATE TABLE project (
                id TEXT PRIMARY KEY,
                name TEXT,
                worktree TEXT NOT NULL
            );
            CREATE TABLE session_v2 (
                id TEXT PRIMARY KEY,
                title TEXT,
                project_id TEXT,
                parent_id TEXT,
                directory TEXT NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
            );
            CREATE TABLE session_message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                seq INTEGER NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .expect("create opencode 2 schema");
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
            insert_session_project(&conn, "omp-1", "omp", "dir:omp-root");
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
            assert_eq!(
                map.get(&(Harness::Omp, "omp-1".to_string())),
                Some(&"dir:omp-root".to_string())
            );
            assert_eq!(map.len(), 3, "unknown harness rows must be skipped");
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
    fn omp_session_display_falls_back_to_exact_pi_identity_without_prefix_matching() {
        with_temp_data_home(|data_home| {
            const MATCHED_ID: &str = "123e4567-e89b-12d3-a456-426614174000";
            const UNMATCHED_ID: &str = "123e4567-e89b-12d3-a456-426614174001";
            const PROJECT_IDENTITY: &str = "git:omp-project";

            let context = create_context_db(data_home, true);
            insert_session_project(&context, MATCHED_ID, "pi", PROJECT_IDENTITY);
            insert_session_project(&context, "123e4567", "pi", PROJECT_IDENTITY);
            drop(context);

            let omp_root = tempfile::tempdir().expect("OMP sessions");
            let project_dir = omp_root.path().join("omp-project");
            std::fs::create_dir_all(&project_dir).expect("OMP project session dir");
            for (session_id, file_name) in [
                (MATCHED_ID, "matched.jsonl"),
                (UNMATCHED_ID, "prefix-only.jsonl"),
            ] {
                std::fs::write(
                    project_dir.join(file_name),
                    format!(
                        "{{\"type\":\"session\",\"version\":3,\"id\":\"{session_id}\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/tmp/omp-project\"}}\n{{\"type\":\"message\",\"id\":\"u1\",\"parentId\":null,\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"hello from OMP\"}}}}\n"
                    ),
                )
                .expect("write OMP session");
            }

            let sessions = crate::pi_sessions::scan_pi_session_dir_at(omp_root.path());
            assert_eq!(sessions.len(), 2, "the OMP fixture must be scanned");
            let rows = list_pi_compatible_sessions(
                &SessionFilter {
                    project_identity: Some(PROJECT_IDENTITY.to_string()),
                    ..SessionFilter::default()
                },
                Harness::Omp,
                sessions,
            );

            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].harness, Harness::Omp);
            assert_eq!(rows[0].session_id, MATCHED_ID);
            assert_eq!(rows[0].project_identity, PROJECT_IDENTITY);
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
            super::schema_fixture::insert_project_memory(
                &context,
                "git:shared-root",
                "CONSTRAINTS",
                "A remembered rule.",
                "active",
            );

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

    fn assert_pj_labels_at_all_sites(
        names: &crate::project_names::ProjectNames,
        labels: [&str; 3],
    ) {
        with_temp_data_home(|data_home| {
            let context = create_context_db(data_home, true);
            let oc = create_opencode_db(data_home);
            let identities = [
                "pj-dashboard-editor",
                "pj-dashboard-terminal",
                "pj-0123456789ABCDEFGHIJ",
            ];
            for (index, identity) in identities.iter().enumerate() {
                let id = format!("project-{index}");
                let directory = data_home.join(&id);
                std::fs::create_dir_all(&directory).unwrap();
                insert_session_project(&context, &id, "opencode", identity);
                super::schema_fixture::insert_project_memory(
                    &context,
                    identity,
                    "CONSTRAINTS",
                    "A remembered rule.",
                    "active",
                );
                oc.execute(
                    "INSERT INTO project (id, name, worktree) VALUES (?1, 'Directory label', ?2)",
                    (&id, directory.to_string_lossy().as_ref()),
                )
                .unwrap();
                oc.execute("INSERT INTO session (id, title, project_id, directory, time_updated) VALUES (?1, 'Session label', ?1, ?2, 100)",
                    (&id, directory.to_string_lossy().as_ref())).unwrap();
            }
            drop(oc);
            let projects = get_projects_with_names(&context, names).unwrap();
            let picker = enumerate_memory_projects_with_names(&context, names).unwrap();
            let cards = get_project_cards_with_names(&context, names);
            assert_eq!(projects.len(), 3);
            assert_eq!(picker.len(), 3);
            assert_eq!(cards.len(), 3);
            for (identity, label) in identities.iter().zip(labels) {
                assert_eq!(
                    projects
                        .iter()
                        .find(|row| row.identity == *identity)
                        .unwrap()
                        .label,
                    label,
                    "get_projects: {identity}"
                );
                assert_eq!(
                    picker
                        .iter()
                        .find(|row| row.identity == *identity)
                        .unwrap()
                        .display_name,
                    label,
                    "enumerate_memory_projects: {identity}"
                );
                assert_eq!(
                    cards
                        .iter()
                        .find(|row| row.identity == *identity)
                        .unwrap()
                        .display_name,
                    label,
                    "get_project_cards: {identity}"
                );
            }
        });
    }

    #[test]
    fn enumerate_vector_names_and_unknown_pj_labels_at_all_three_sites() {
        let vector: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test-vectors/project-resolve-v1/enumerate.json"
        ))
        .unwrap();
        let names =
            crate::project_names::parse_names(&serde_json::to_vec(&vector[0]["reply"]).unwrap())
                .unwrap();
        assert_pj_labels_at_all_sites(&names, ["Editor", "Terminal", "pj-0123456789…"]);
    }

    #[test]
    fn absent_entorhinal_uses_short_pj_labels_at_all_three_sites() {
        assert_pj_labels_at_all_sites(
            &HashMap::new(),
            ["pj-dashboard-…", "pj-dashboard-…", "pj-0123456789…"],
        );
    }

    #[test]
    fn get_project_cards_lists_opencode2_sessions_from_session_v2_with_their_directory() {
        with_temp_data_home(|data_home| {
            let temp = tempfile::tempdir().expect("projects");
            let project = temp.path().join("global");
            std::fs::create_dir_all(&project).expect("project dir");
            let project_path = project.to_string_lossy().to_string();

            let context = create_context_db(data_home, true);
            insert_session_project(&context, "ses_v2", "opencode2", "dir:6fb76e42d6dd");
            super::schema_fixture::insert_project_memory(
                &context,
                "dir:6fb76e42d6dd",
                "CONSTRAINTS",
                "A remembered rule.",
                "active",
            );

            let oc = create_opencode2_db(data_home);
            oc.execute(
                "INSERT INTO project (id, name, worktree) VALUES ('p1', NULL, ?1)",
                [project_path.as_str()],
            )
            .expect("insert project");
            oc.execute(
                "INSERT INTO session_v2 (id, title, project_id, directory, time_updated, time_archived)
                 VALUES ('ses_v2', 'Live session', 'p1', ?1, 500, NULL)",
                [project_path.as_str()],
            )
            .expect("insert v2 session");
            drop(oc);

            let sessions = list_opencode_sessions(&SessionFilter::default());
            assert_eq!(sessions.len(), 1, "the OpenCode 2 session must be listed");
            assert_eq!(sessions[0].harness, Harness::Opencode2);
            assert_eq!(sessions[0].project_identity, "dir:6fb76e42d6dd");

            let cards = get_project_cards(&context);
            assert_eq!(cards.len(), 1, "the OpenCode 2 project must get a card");
            let card = &cards[0];
            assert_eq!(card.identity, "dir:6fb76e42d6dd");
            assert_eq!(card.primary_path, project_path);
            assert_eq!(card.display_name, "global");
            assert_eq!(card.harnesses, vec![Harness::Opencode2]);
            assert_eq!(card.session_count, 1);
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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

        let messages =
            load_opencode_messages(&conn, OpenCodeStoreGeneration::V1, "ses_test").expect("load");
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
            native_turn_id: None,
            context_limit: None,
            provider: None,
            model: None,

            cache_reported: true,
        }
    }

    fn with_native_turn(mut event: RawDbCacheEvent, turn_id: &str) -> RawDbCacheEvent {
        event.native_turn_id = Some(turn_id.to_string());
        event
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
    fn opencode_session_query_uses_parent_id_as_the_native_turn() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE message (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                data TEXT NOT NULL
            );",
        )
        .unwrap();
        for (message_id, timestamp) in [("assistant-1", 100), ("assistant-2", 200)] {
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
                params![
                    message_id,
                    "s1",
                    timestamp,
                    serde_json::json!({
                        "role": "assistant",
                        "parentID": "user-1",
                        "finish": "stop",
                        "tokens": { "input": 10, "cache": { "read": 80, "write": 10 }, "total": 100 }
                    })
                    .to_string()
                ],
            )
            .unwrap();
        }

        let events = get_opencode_session_cache_events_from_conn(
            &conn,
            OpenCodeStoreGeneration::V1,
            "s1",
            Some(10),
            None,
        );
        assert_eq!(events.len(), 2);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert!(events.iter().all(|event| event.turn_id == "user-1"));
    }

    #[test]
    fn opencode_and_pi_events_carry_their_provider_and_model() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                                   time_created INTEGER NOT NULL, data TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, data) VALUES ('a1', 's1', 100, ?1)",
            params![serde_json::json!({
                "role": "assistant", "providerID": "anthropic", "modelID": "claude-opus-5",
                "tokens": { "input": 10, "cache": { "read": 80, "write": 10 }, "total": 100 }
            })
            .to_string()],
        )
        .unwrap();
        let events = get_opencode_session_cache_events_from_conn(
            &conn,
            OpenCodeStoreGeneration::V1,
            "s1",
            Some(10),
            None,
        );
        assert_eq!(events[0].provider.as_deref(), Some("anthropic"));
        assert_eq!(events[0].model.as_deref(), Some("claude-opus-5"));

        let pi_entry = serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "provider": "openai", "model": "gpt-6"}
        });
        assert_eq!(
            pi_message_provider_model(&pi_entry),
            (Some("openai".to_string()), Some("gpt-6".to_string()))
        );
        assert_eq!(
            pi_message_provider_model(&serde_json::json!({"message": {}})),
            (None, None)
        );
    }

    #[test]
    fn native_opencode_parent_id_overrides_finish_heuristics() {
        let rows = vec![
            with_native_turn(
                raw(
                    Harness::Opencode,
                    "assistant-1",
                    "s1",
                    100,
                    10,
                    80,
                    10,
                    100,
                    Some("tool-calls"),
                ),
                "user-1",
            ),
            with_native_turn(
                raw(
                    Harness::Opencode,
                    "assistant-2",
                    "s1",
                    100,
                    10,
                    85,
                    5,
                    100,
                    Some("tool-calls"),
                ),
                "user-2",
            ),
        ];

        let events = build_db_cache_events(rows, false);
        assert_eq!(events.iter().filter(|event| event.is_turn_start).count(), 2);
        assert_eq!(
            events
                .iter()
                .map(|event| event.turn_id.as_str())
                .collect::<HashSet<_>>(),
            HashSet::from(["user-1", "user-2"]),
            "queued users with colliding timestamps remain distinct native turns"
        );
    }

    #[test]
    fn native_opencode_parent_groups_every_request_in_a_multi_step_turn() {
        let rows = vec![
            with_native_turn(
                raw(
                    Harness::Opencode,
                    "assistant-1",
                    "s1",
                    100,
                    10,
                    80,
                    10,
                    100,
                    Some("stop"),
                ),
                "user-1",
            ),
            with_native_turn(
                raw(
                    Harness::Opencode,
                    "assistant-2",
                    "s1",
                    200,
                    10,
                    85,
                    5,
                    100,
                    Some("stop"),
                ),
                "user-1",
            ),
        ];

        let events = build_db_cache_events(rows, false);
        assert!(events[0].is_turn_start);
        assert!(!events[1].is_turn_start);
        assert!(events.iter().all(|event| event.turn_id == "user-1"));
    }

    #[test]
    fn jsonl_tool_continuation_finish_values_group_requests() {
        for (harness, finish) in [(Harness::Pi, "toolUse"), (Harness::ClaudeCode, "tool_use")] {
            let rows = vec![
                raw(harness, "m1", "s1", 100, 10, 80, 10, 100, Some(finish)),
                raw(harness, "m2", "s1", 200, 10, 85, 5, 100, Some("stop")),
            ];
            let events = build_db_cache_events(rows, false);
            assert!(events[0].is_turn_start, "{harness:?}");
            assert!(!events[1].is_turn_start, "{harness:?}");
            assert_eq!(events[0].turn_id, events[1].turn_id, "{harness:?}");
        }
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
            ("tag_identity_repair", "Tag identity repair"),
            ("latest_turn_thinking_removed", "Rejected thinking removed"),
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
            Some(HashMap::new()),
        );
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            events[1].cause.as_deref(),
            Some(MC_TRANSFORM_FAILED_OPEN_CAUSE)
        );
    }

    // ── Provider-side cache losses (idle expiry, provider cache miss) ──
    //
    // Fixtures model an Anthropic OpenCode session with a large cached prompt:
    // the warm request read 682k from the cache (prompt total 695,053, so the
    // short-read floor is 694,989), and the busting request read 0 cached + 4
    // uncached tokens and rewrote its whole prompt, which grew to 695,104.

    const T0: i64 = 1_760_000_000_000;
    const SECOND: i64 = 1_000;

    fn anthropic_step(
        message_id: &str,
        timestamp: i64,
        input: i64,
        read: i64,
        write: i64,
    ) -> RawDbCacheEvent {
        let mut event = raw(
            Harness::Opencode,
            message_id,
            "s1",
            timestamp,
            input,
            read,
            write,
            input + read + write,
            Some("stop"),
        );
        event.provider = Some("anthropic".to_string());
        event
    }

    /// A warm Anthropic request, then one `gap_ms` later that read nothing and
    /// rewrote a prompt no smaller than the previous one.
    fn warm_then_cold(gap_ms: i64) -> Vec<RawDbCacheEvent> {
        warm_then_cold_rewriting(gap_ms, 695_100)
    }

    /// Like `warm_then_cold`, with the busting request writing `rewritten`
    /// tokens (its prompt total is `rewritten + 4`).
    fn warm_then_cold_rewriting(gap_ms: i64, rewritten: i64) -> Vec<RawDbCacheEvent> {
        vec![
            anthropic_step("m1", T0, 3, 682_000, 13_050),
            anthropic_step("m2", T0 + gap_ms, 4, 0, rewritten),
        ]
    }

    fn decision(decision: &str, reason: Option<&str>) -> TransformDecisionCause {
        TransformDecisionCause {
            decision: decision.to_string(),
            materialize_reason: reason.map(str::to_string),
            emergency: false,
        }
    }

    /// Attribute `rows` (session `s1`) with an optional decision on `m2` and the
    /// session's recorded `cache_ttl`, without reading any store.
    fn attribute(
        rows: Vec<RawDbCacheEvent>,
        m2_decision: Option<TransformDecisionCause>,
        recorded_ttl: Option<&str>,
    ) -> Vec<DbCacheEvent> {
        let decisions = m2_decision
            .map(|row| {
                HashMap::from([((Harness::Opencode, "s1".to_string(), "m2".to_string()), row)])
            })
            .unwrap_or_default();
        let ttls = recorded_ttl
            .map(|ttl| HashMap::from([((Harness::Opencode, "s1".to_string()), ttl.to_string())]))
            .unwrap_or_default();
        build_db_cache_events_with_attribution(
            rows,
            true,
            Some(decisions),
            Some(HashSet::new()),
            Some(ttls),
        )
    }

    fn m2_cause(events: &[DbCacheEvent]) -> Option<&str> {
        let m2 = events
            .iter()
            .find(|event| event.message_id == "m2")
            .expect("m2 event");
        m2.cause.as_deref()
    }

    #[test]
    fn passes_that_changed_nothing_are_not_a_cause() {
        // Rust SOFT+ replay, raw pass-through, full-sync, and a frozen-replay
        // release that changed no block all served the bytes the provider had.
        for row in [
            decision("defer", None),
            decision("passthrough", Some("pending_rewrite")),
            decision("need_full_sync", None),
            decision("unknown", Some("marker_admission_failed")),
            decision(
                "passthrough",
                Some("lkg_frozen_release:raw_replay_gap;first_changed=none"),
            ),
        ] {
            assert_eq!(transform_decision_cause(Some(&row)), None, "{row:?}");
        }
        // A frozen-replay release that changed a block, and every rebuild
        // reason, still explain the loss.
        let release = "lkg_frozen_release:raw_replay_gap;first_changed=msg_9#0";
        assert_eq!(
            transform_decision_cause(Some(&decision("passthrough", Some(release)))).as_deref(),
            Some(release)
        );
        assert_eq!(
            transform_decision_cause(Some(&decision("defer", Some("explicit_flush")))).as_deref(),
            Some("Manual flush")
        );
        assert_eq!(
            transform_decision_cause(Some(&decision("execute", Some("m1_delta")))).as_deref(),
            Some("M1 delta")
        );
    }

    #[test]
    fn system_hash_is_a_system_prompt_change_whatever_the_pass_did() {
        // The plugin records system_hash on deferred, pass-through and
        // placeholder rows too: the changed prompt rewrites the provider cache.
        for kind in ["defer", "passthrough", "unknown", "execute"] {
            assert_eq!(
                transform_decision_cause(Some(&decision(kind, Some("system_hash")))).as_deref(),
                Some("System prompt change"),
                "{kind}"
            );
        }
        // Ten seconds after a warm read, the recorded cause wins over the
        // provider-miss label.
        let events = attribute(
            warm_then_cold(10 * SECOND),
            Some(decision("passthrough", Some("system_hash"))),
            Some("never"),
        );
        assert_eq!(m2_cause(&events), Some("System prompt change"));
    }

    #[test]
    fn no_change_pass_is_never_shown_as_the_bust_cause() {
        // Reported: 248 and 183 min idle, `passthrough`/`pending_rewrite`.
        let row = decision("passthrough", Some("pending_rewrite"));
        let events = attribute(
            warm_then_cold(248 * MINUTE_MS),
            Some(row.clone()),
            Some("never"),
        );
        assert_eq!(events[1].severity, "full_bust");
        assert_eq!(
            m2_cause(&events),
            Some("Cache expired after 4 h 8 min idle")
        );
        let events = attribute(
            warm_then_cold(183 * MINUTE_MS),
            Some(row.clone()),
            Some("never"),
        );
        assert_eq!(
            m2_cause(&events),
            Some("Cache expired after 3 h 3 min idle")
        );
        // Reported: 6 min after a host restart. Neither bound applies, and the
        // pass-through's reason is not a cause either.
        let events = attribute(warm_then_cold(6 * MINUTE_MS), Some(row), Some("never"));
        assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
        // A SOFT+ replay ten seconds after a warm read.
        let events = attribute(
            warm_then_cold(10 * SECOND),
            Some(decision("defer", None)),
            Some("never"),
        );
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
    }

    #[test]
    fn unknown_ttl_uses_the_documented_bounds_and_is_silent_between_them() {
        // Reported: 0.1 min after a 380k warm read, no decision row.
        let events = attribute(warm_then_cold(6 * SECOND), None, Some("never"));
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
        // Reported: 11.3 and 17.1 min, no decision row. Past Anthropic's 5 min
        // default but within its 1 h maximum: either cause is possible.
        for gap in [678 * SECOND, 1_026 * SECOND] {
            let events = attribute(warm_then_cold(gap), None, Some("never"));
            assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
        }
        // No recorded TTL at all behaves the same.
        let events = attribute(warm_then_cold(6 * SECOND), None, None);
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
        let events = attribute(warm_then_cold(61 * MINUTE_MS), None, None);
        assert_eq!(m2_cause(&events), Some("Cache expired after 61 min idle"));
    }

    #[test]
    fn documented_bounds_are_exclusive() {
        let cause_at =
            |gap| m2_cause(&attribute(warm_then_cold(gap), None, None)).map(str::to_string);
        let five = 5 * MINUTE_MS;
        let hour = 60 * MINUTE_MS;
        assert_eq!(
            cause_at(five - 1).as_deref(),
            Some(PROVIDER_CACHE_MISS_CAUSE)
        );
        assert_eq!(
            cause_at(five).as_deref(),
            Some(UNATTRIBUTED_CACHE_BUST_CAUSE)
        );
        assert_eq!(
            cause_at(hour).as_deref(),
            Some(UNATTRIBUTED_CACHE_BUST_CAUSE)
        );
        assert_eq!(
            cause_at(hour + 1).as_deref(),
            Some("Cache expired after 60 min idle")
        );
    }

    #[test]
    fn known_ttl_session_labels_against_its_own_ttl() {
        // MC recorded 5m: 6 min idle expired it, 4 min did not.
        let events = attribute(warm_then_cold(6 * MINUTE_MS), None, Some("5m"));
        assert_eq!(m2_cause(&events), Some("Cache expired after 6 min idle"));
        let events = attribute(warm_then_cold(4 * MINUTE_MS), None, Some("5m"));
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
        // MC recorded 1h: 11 min is well inside it, so the loss is a miss.
        let events = attribute(warm_then_cold(11 * MINUTE_MS), None, Some("1h"));
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
        // A recorded TTL applies even to a provider with no documented row.
        let mut rows = warm_then_cold(31 * MINUTE_MS);
        for row in &mut rows {
            row.provider = Some("openai".to_string());
        }
        let events = attribute(rows, None, Some("30m"));
        assert_eq!(m2_cause(&events), Some("Cache expired after 31 min idle"));
    }

    #[test]
    fn provider_without_documented_bounds_gets_no_label() {
        for gap in [6 * SECOND, 248 * MINUTE_MS] {
            let mut rows = warm_then_cold(gap);
            for row in &mut rows {
                row.provider = Some("openrouter".to_string());
            }
            let events = attribute(rows, None, Some("never"));
            assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
        }
    }

    #[test]
    fn recorded_magic_context_causes_win_over_provider_side_labels() {
        // A fold Magic Context recorded on this request is its cause, even when
        // the gap alone would also have expired the cache.
        let events = attribute(
            warm_then_cold(248 * MINUTE_MS),
            Some(decision("execute", Some("pressure_refold"))),
            Some("never"),
        );
        assert_eq!(m2_cause(&events), Some("Compaction pressure"));
        let events = attribute(
            warm_then_cold(6 * MINUTE_MS),
            Some(decision("execute", Some("ttl_idle"))),
            Some("5m"),
        );
        assert_eq!(m2_cause(&events), Some("Idle cache refresh"));
        // Seconds after a warm read, a recorded fold is the fold, not a miss.
        let events = attribute(
            warm_then_cold(10 * SECOND),
            Some(decision("execute", None)),
            Some("5m"),
        );
        assert_eq!(
            m2_cause(&events),
            Some("Execute pass (reclaimed tool output)")
        );
        // A transform error recorded for the session wins too.
        let events = build_db_cache_events_with_attribution(
            warm_then_cold(10 * SECOND),
            true,
            Some(HashMap::new()),
            Some(HashSet::from([(Harness::Opencode, "s1".to_string())])),
            Some(HashMap::new()),
        );
        assert_eq!(m2_cause(&events), Some(MC_TRANSFORM_FAILED_OPEN_CAUSE));
    }

    #[test]
    fn warm_sequence_gets_no_label() {
        // Each request reads the previous prefix plus what it wrote: seconds
        // apart, after 30 min, and after 2 h (a setup that re-sends requests to
        // keep the provider cache alive can read warm after any gap). Stable
        // rows carry no cause, whatever the gap.
        let rows = vec![
            anthropic_step("m1", T0, 3, 682_000, 13_050),
            anthropic_step("m2", T0 + 4 * SECOND, 2, 695_050, 1_200),
            anthropic_step("m3", T0 + 9 * SECOND, 5, 696_250, 900),
            anthropic_step("m4", T0 + 30 * MINUTE_MS, 1, 697_150, 300),
            anthropic_step("m5", T0 + 150 * MINUTE_MS, 2, 697_450, 700),
        ];
        let events = attribute(rows, None, Some("never"));
        for event in &events[1..] {
            assert_eq!(event.severity, "stable", "{}", event.message_id);
            assert_eq!(event.cause, None, "{}", event.message_id);
        }
    }

    #[test]
    fn bust_the_meter_does_not_call_short_is_not_a_provider_miss() {
        // The cached read fell (retention 0.66, a bust), but Anthropic's meter
        // counts the uncached input too: 460k read + 236k input is not below
        // the 694,989 floor, so nothing says the provider dropped its cache.
        let rows = vec![
            anthropic_step("m1", T0, 3, 682_000, 13_050),
            anthropic_step("m2", T0 + 10 * SECOND, 236_000, 460_000, 0),
        ];
        let events = attribute(rows, None, Some("never"));
        assert_eq!(events[1].severity, "bust");
        assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
    }

    #[test]
    fn fast_cold_read_with_a_shrunk_prompt_gets_no_provider_label() {
        // 10 s after a warm read the prompt shrank by 13,143 tokens (below the
        // 15k drop marker): the request changed, so the loss is not put on the
        // provider.
        let events = attribute(
            warm_then_cold_rewriting(10 * SECOND, 681_906),
            None,
            Some("never"),
        );
        assert_eq!(events[1].severity, "full_bust");
        assert!(!events[1].is_drop);
        assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
        // A prompt total 55k smaller than the previous one is also marked as a
        // context drop (is_drop, 15k or more). The step still gets the single
        // Unattributed cause, never the provider-miss label next to the drop.
        let events = attribute(
            warm_then_cold_rewriting(10 * SECOND, 640_000),
            None,
            Some("never"),
        );
        assert!(events[1].is_drop);
        assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
        // The shrink check uses the same floor as the short-read meter rule
        // (previous prompt total 695,053 minus max(64, 3) = 694,989): a prompt
        // total of exactly 694,989 did not shrink, one token less did.
        let events = attribute(
            warm_then_cold_rewriting(10 * SECOND, 694_985),
            None,
            Some("never"),
        );
        assert_eq!(m2_cause(&events), Some(PROVIDER_CACHE_MISS_CAUSE));
        let events = attribute(
            warm_then_cold_rewriting(10 * SECOND, 694_984),
            None,
            Some("never"),
        );
        assert_eq!(m2_cause(&events), Some(UNATTRIBUTED_CACHE_BUST_CAUSE));
    }

    #[test]
    fn meter_rule_matches_the_analyzer_floor() {
        let step = |input, read, write| DbCacheEvent {
            harness: Harness::Opencode,
            message_id: String::new(),
            session_id: String::new(),
            timestamp: 0,
            input_tokens: input,
            cache_read: read,
            cache_write: write,
            cache_reported: true,
            total_tokens: 0,
            hit_ratio: 0.0,
            severity: String::new(),
            cause: None,
            agent: None,
            finish: None,
            native_turn_id: None,
            turn_id: String::new(),
            is_turn_start: false,
            context_limit: 0,
            context_limit_estimated: false,
            is_drop: false,
            context_reduced_by_mc: true,

            cold_start: false,

            provider: None,
            model: None,
        };
        // Previous total 695,053 and epsilon max(64, 3) = 64, so a comparable
        // read below 694,989 is short.
        let previous = step(3, 682_000, 13_050);
        assert!(meter_reports_short_read(
            &previous,
            &step(4, 0, 681_906),
            true
        ));
        assert!(meter_reports_short_read(
            &previous,
            &step(0, 694_988, 0),
            true
        ));
        assert!(!meter_reports_short_read(
            &previous,
            &step(0, 694_989, 0),
            true
        ));
        // A larger previous uncached input widens the short-read allowance,
        // because epsilon is then that input (1,000), not 64.
        let previous = step(1_000, 600_000, 0);
        assert!(!meter_reports_short_read(
            &previous,
            &step(0, 600_000, 0),
            true
        ));
        assert!(meter_reports_short_read(
            &previous,
            &step(0, 599_999, 0),
            true
        ));
        // An implicit-prefix cache counts only the cached read.
        assert!(meter_reports_short_read(
            &previous,
            &step(50_000, 551_000, 0),
            false
        ));
        assert!(!meter_reports_short_read(
            &previous,
            &step(50_000, 551_000, 0),
            true
        ));
    }

    #[test]
    fn recorded_cache_ttl_parses_like_the_plugin() {
        assert_eq!(parse_recorded_cache_ttl_ms("5m"), Some(5 * MINUTE_MS));
        assert_eq!(parse_recorded_cache_ttl_ms(" 1h "), Some(60 * MINUTE_MS));
        assert_eq!(parse_recorded_cache_ttl_ms("30s"), Some(30 * SECOND));
        assert_eq!(parse_recorded_cache_ttl_ms("300000"), Some(5 * MINUTE_MS));
        for unknown in ["never", "NEVER", "", "5 m", "5d", "0m", "m"] {
            assert_eq!(parse_recorded_cache_ttl_ms(unknown), None, "{unknown}");
        }
    }

    #[test]
    fn session_cache_ttl_loader_reads_session_meta() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                cache_ttl TEXT
            );
            INSERT INTO session_meta (session_id, harness, cache_ttl) VALUES
                ('ses_known', 'opencode', '1h'),
                ('ses_converted', 'opencode', '5m'),
                ('ses_never', 'opencode', 'never'),
                ('ses_null', 'opencode', NULL);",
        )
        .unwrap();
        let keys = HashSet::from([
            (Harness::Opencode, "ses_known".to_string()),
            (Harness::Opencode2, "ses_converted".to_string()),
            (Harness::Opencode, "ses_never".to_string()),
            (Harness::Opencode, "ses_null".to_string()),
            (Harness::Pi, "ses_known".to_string()),
        ]);
        let ttls = load_session_cache_ttls_from_conn(&conn, &keys);
        assert_eq!(
            ttls,
            HashMap::from([
                (
                    (Harness::Opencode, "ses_known".to_string()),
                    "1h".to_string()
                ),
                (
                    (Harness::Opencode2, "ses_converted".to_string()),
                    "5m".to_string()
                ),
                (
                    (Harness::Opencode, "ses_never".to_string()),
                    "never".to_string()
                ),
            ])
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

    fn context_limit_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                last_usage_context_limit INTEGER
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn context_limit_resolver_matches_same_harness_row() {
        let conn = context_limit_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, harness, last_usage_context_limit)
             VALUES ('s-pi', 'pi', 200000)",
            [],
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Pi, "s-pi".to_string())]);

        let limits = resolve_session_context_limits_from_conn(&conn, &keys);

        assert_eq!(
            limits,
            HashMap::from([((Harness::Pi, "s-pi".to_string()), 200_000)])
        );
    }

    #[test]
    fn context_limit_resolver_matches_opencode_row_for_opencode2_session() {
        // OpenCode 2 conversion keeps the session id, so the timeline can list
        // the session under `opencode2` while the plugin recorded its limit
        // under `opencode`. The resolver must still find it, otherwise the
        // chart auto-scales to the session's own max prompt.
        let conn = context_limit_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, harness, last_usage_context_limit)
             VALUES ('ses_1', 'opencode', 917504)",
            [],
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Opencode2, "ses_1".to_string())]);

        let limits = resolve_session_context_limits_from_conn(&conn, &keys);

        assert_eq!(
            limits,
            HashMap::from([((Harness::Opencode2, "ses_1".to_string()), 917_504)]),
            "opencode2 timeline session must inherit the limit recorded under opencode"
        );
    }

    #[test]
    fn context_limit_resolver_prefers_exact_harness_on_shared_id() {
        let conn = context_limit_conn();
        conn.execute_batch(
            "INSERT INTO session_meta (session_id, harness, last_usage_context_limit) VALUES
                ('ses_1', 'opencode', 917504),
                ('ses_1', 'opencode2', 786432);",
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Opencode2, "ses_1".to_string())]);

        let limits = resolve_session_context_limits_from_conn(&conn, &keys);

        assert_eq!(
            limits,
            HashMap::from([((Harness::Opencode2, "ses_1".to_string()), 786_432)]),
            "an exact opencode2 row wins over the opencode row for the same id"
        );
    }

    #[test]
    fn context_limit_resolver_does_not_alias_across_harness_families() {
        // OpenCode ids and Pi ids have different shapes, so a Pi timeline
        // session must never inherit a limit recorded for an OpenCode row
        // that happens to share the id string.
        let conn = context_limit_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, harness, last_usage_context_limit)
             VALUES ('shared', 'opencode', 917504)",
            [],
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Pi, "shared".to_string())]);

        let limits = resolve_session_context_limits_from_conn(&conn, &keys);

        assert!(limits.is_empty());
    }

    fn transform_decision_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE transform_decisions (
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                message_id TEXT NOT NULL,
                decision TEXT NOT NULL,
                materialize_reason TEXT,
                emergency INTEGER NOT NULL DEFAULT 0
            );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn transform_decision_loader_matches_opencode_row_for_opencode2_session() {
        let conn = transform_decision_conn();
        conn.execute(
            "INSERT INTO transform_decisions
             (session_id, harness, message_id, decision, materialize_reason, emergency)
             VALUES ('ses_1', 'opencode', 'm1', 'compact', 'budget', 0)",
            [],
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Opencode2, "ses_1".to_string())]);

        let decisions = load_transform_decision_causes_from_conn(&conn, &keys);

        let cause = decisions
            .get(&(Harness::Opencode2, "ses_1".to_string(), "m1".to_string()))
            .expect("opencode2 session must see the decision recorded under opencode");
        assert_eq!(cause.decision, "compact");
    }

    #[test]
    fn transform_failure_loader_matches_opencode_row_for_opencode2_session() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT NOT NULL,
                harness TEXT NOT NULL,
                last_transform_error TEXT
            );
            INSERT INTO session_meta (session_id, harness, last_transform_error)
            VALUES ('ses_1', 'opencode', 'transform failed');",
        )
        .unwrap();
        let keys = HashSet::from([(Harness::Opencode2, "ses_1".to_string())]);

        let failures = load_transform_failure_sessions_from_conn(&conn, &keys);

        assert_eq!(
            failures,
            HashSet::from([(Harness::Opencode2, "ses_1".to_string())]),
            "opencode2 session must see the failure recorded under opencode"
        );
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
    fn non_anthropic_growth_uses_input_only() {
        // Without a reported cache write, generated output is not counted as
        // next-step cached input; measured traces show cache growth comes from
        // previously uncached input.
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
                102_000,
                0,
                103_200,
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
                "INSERT INTO mc_cache_state (session_id) VALUES (?1), (?2), (?3), (?4), (?5)",
                params![
                    "cc-exact",
                    "cc-composite␟agent␟1",
                    "cc-other-suffix",
                    "codex-exact",
                    "broca-with-state",
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
            (Harness::Broca, "broca-with-state".to_string()),
            (Harness::Broca, "broca-without-state".to_string()),
        ]);
        let managed = load_mc_state_sessions_from_path(&path, &keys);
        assert!(managed.contains(&(Harness::ClaudeCode, "cc-exact".to_string())));
        assert!(managed.contains(&(Harness::ClaudeCode, "cc-composite".to_string())));
        assert!(!managed.contains(&(Harness::ClaudeCode, "cc-other".to_string())));
        assert!(managed.contains(&(Harness::Codex, "codex-exact".to_string())));
        assert!(!managed.contains(&(Harness::Opencode, "oc-session".to_string())));
        // Broca sessions are detected the same way. The Cache list shows every
        // Broca session regardless, but only one with state counts as having
        // its context managed by Magic Context.
        assert!(managed.contains(&(Harness::Broca, "broca-with-state".to_string())));
        assert!(!managed.contains(&(Harness::Broca, "broca-without-state".to_string())));
        for id in ["broca-with-state", "broca-without-state"] {
            assert!(is_managed_cache_session(Harness::Broca, id, &managed));
        }
        assert!(session_context_reduced_by_mc(
            Harness::Broca,
            "broca-with-state",
            &managed
        ));
        assert!(!session_context_reduced_by_mc(
            Harness::Broca,
            "broca-without-state",
            &managed
        ));
        assert!(session_context_reduced_by_mc(
            Harness::Opencode,
            "oc-session",
            &managed
        ));
    }

    #[test]
    fn managed_detection_absent_store_degrades_to_unmanaged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-store.db");
        let keys = HashSet::from([(Harness::ClaudeCode, "cc-session".to_string())]);
        assert!(load_mc_state_sessions_from_path(&path, &keys).is_empty());
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
            cache_reported: true,
            total_tokens: 100,
            hit_ratio: 0.8,
            severity: "stable".to_string(),
            cause: None,
            agent: None,
            finish: Some("stop".to_string()),
            native_turn_id: None,
            turn_id: String::new(),
            is_turn_start,
            context_limit: 0,
            context_limit_estimated: false,
            is_drop: false,
            context_reduced_by_mc: true,

            cold_start: false,

            provider: None,
            model: None,
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

    /// An in-memory store at the schema version the dashboard reads, where
    /// `get_memories` and `get_memory_stats` run end-to-end. The store's own
    /// triggers keep `memories_fts` in step with `memories`.
    fn make_memory_db() -> Connection {
        super::schema_fixture::context_db_in_memory()
    }

    /// Insert a project memory owned by `project_path`, written under the tag
    /// `category` and filed under the category ck-mc maps that tag to.
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
                (level, owner_id, category, origin_category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES ('project', ?1, ?2, ?3, ?4, ?5,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     ?6, 1000, 1000)",
            (
                project_path,
                super::schema_fixture::category_id(category),
                category,
                content,
                normalized_hash,
                status,
            ),
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
    fn get_memories_reads_classify_columns_and_embedding_presence() {
        let conn = make_memory_db();
        let id = insert_memory(&conn, "/tmp/v44", "ARCHITECTURE", "active");
        conn.execute(
            "UPDATE memories SET importance = 88, scope = 'ecosystem', shareable = 1 WHERE id = ?1",
            [id],
        )
        .expect("set classify values");
        // One memory with an embedding per model still lists once.
        conn.execute_batch(&format!(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES ({id}, X'00', 'a'), ({id}, X'00', 'b');"
        ))
        .expect("insert embeddings");

        let rows = get_memories(&conn, None, None, None, None, None, 100, 0).expect("get_memories");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].importance, 88);
        assert_eq!(rows[0].scope, "ecosystem");
        assert!(rows[0].shareable);
        assert!(rows[0].has_embedding);
        assert_eq!(
            get_memory_stats(&conn, None, None)
                .expect("stats")
                .with_embeddings,
            1
        );
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
        // `m.owner_id IN ()` and crash the whole stats query. The
        // with_embeddings branch previously rebuilt the IN-list from an empty
        // resolved_paths instead of honoring the `0 = 1` empty-filter sentinel.
        let conn = make_memory_db();
        insert_memory(&conn, "/tmp/has-mem", "X", "active");
        // An embedding row exists so the with_embeddings branch actually runs.
        conn.execute(
            "INSERT INTO memory_embeddings (memory_id, embedding, model_id) VALUES (1, X'00', 'm')",
            [],
        )
        .expect("insert embedding");

        let stats = get_memory_stats(&conn, Some("git:does-not-exist"), None)
            .expect("stats must not crash on an empty-resolved filter");
        assert_eq!(stats.total, 0);
        assert_eq!(stats.with_embeddings, 0);
        assert!(stats.categories.is_empty());
    }

    fn insert_paged_memory(
        conn: &Connection,
        project_path: &str,
        category: &str,
        status: &str,
        content: &str,
        updated_at: i64,
    ) -> i64 {
        // The store's insert trigger indexes the row for full-text search.
        conn.execute(
            "INSERT INTO memories
                (level, owner_id, category, origin_category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES ('project', ?1, ?2, ?3, ?4, ?5,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     ?6, ?7, ?7)",
            (
                project_path,
                super::schema_fixture::category_id(category),
                category,
                content,
                format!("{:x}", md5::compute(content)),
                status,
                updated_at,
            ),
        )
        .expect("insert paged memory");
        conn.last_insert_rowid()
    }

    #[test]
    fn category_counts_cover_every_row_past_the_first_page() {
        // A category larger than one list page must report its full count, and
        // the same filter must return the row past that page. Archived rows are
        // omitted from the default totals and from that page.
        let conn = make_memory_db();
        // updated_at descends, so the first page is the 200 newest rows and
        // offset 200 is the oldest active row.
        let mut oldest_active = 0;
        for index in 0..201 {
            let id = insert_paged_memory(
                &conn,
                "/tmp/big",
                "ARCHITECTURE",
                "active",
                &format!("architecture row {index}"),
                index,
            );
            if index == 0 {
                oldest_active = id;
            }
        }
        for index in 0..5 {
            insert_paged_memory(
                &conn,
                "/tmp/big",
                "ARCHITECTURE",
                "archived",
                &format!("archived architecture {index}"),
                1_000 + index,
            );
        }
        insert_paged_memory(
            &conn,
            "/tmp/big",
            "CONSTRAINTS",
            "active",
            "constraint row",
            2_000,
        );
        insert_paged_memory(
            &conn,
            "/tmp/other",
            "ARCHITECTURE",
            "active",
            "other project",
            3_000,
        );

        let identity = stable_dir_identity("/tmp/big");
        let stats = get_memory_stats_scoped(
            &conn,
            MemoryStatsScope {
                project: Some(&identity),
                workspace_id: None,
                status: None,
                search: None,
                include_archived: false,
            },
        )
        .expect("stats");
        let architecture = stats
            .categories
            .iter()
            .find(|row| row.category == "ARCHITECTURE")
            .expect("architecture count");
        assert_eq!(architecture.count, 201);
        let constraints = stats
            .categories
            .iter()
            .find(|row| row.category == "CONSTRAINTS")
            .expect("constraints count");
        assert_eq!(constraints.count, 1);

        let page = get_memories_filtered(
            &conn,
            Some(&identity),
            None,
            None,
            Some("ARCHITECTURE"),
            None,
            true,
            200,
            200,
        )
        .expect("page past the first 200");
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, oldest_active);

        let archived = get_memory_stats_scoped(
            &conn,
            MemoryStatsScope {
                project: Some(&identity),
                workspace_id: None,
                status: Some("archived"),
                search: None,
                include_archived: false,
            },
        )
        .expect("archived stats");
        assert_eq!(archived.categories.len(), 1);
        assert_eq!(archived.categories[0].count, 5);

        let searched = get_memory_stats_scoped(
            &conn,
            MemoryStatsScope {
                project: Some(&identity),
                workspace_id: None,
                status: None,
                search: Some("constraint row"),
                include_archived: false,
            },
        )
        .expect("search stats");
        assert_eq!(searched.categories.len(), 1);
        assert_eq!(searched.categories[0].category, "CONSTRAINTS");
        assert_eq!(searched.categories[0].count, 1);
        let searched_rows = get_memories_filtered(
            &conn,
            Some(&identity),
            None,
            None,
            None,
            Some("constraint row"),
            true,
            50,
            0,
        )
        .expect("search list");
        assert_eq!(searched_rows.len(), 1);
    }

    #[test]
    fn get_projects_degrades_on_pre_dreamer_v2_schema() {
        // The dashboard opens DBs read-only and never migrates, so a DB older
        // than the Dreamer V2 schema has no task_schedule_state / dream_runs.
        // get_projects must still return memory-derived projects, not throw
        // "no such table".
        let conn = make_memory_db();
        conn.execute_batch("DROP TABLE task_schedule_state; DROP TABLE dream_runs;")
            .expect("drop the Dreamer V2 tables");
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
        conn.execute_batch("DROP TABLE dream_state;")
            .expect("drop dream_state");
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

    fn insert_memory_with_content(conn: &Connection, content: &str, updated_at: i64) -> i64 {
        // The store's insert trigger indexes the row for full-text search.
        conn.execute(
            "INSERT INTO memories
                (level, owner_id, category, origin_category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES ('project', '/tmp/search', 'swe:constraints', 'CONSTRAINTS', ?1, ?2,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     'active', 1000, ?3)",
            (content, format!("{:x}", md5::compute(content)), updated_at),
        )
        .expect("insert memory");
        conn.last_insert_rowid()
    }

    #[test]
    fn like_search_matches_a_backslash_literally() {
        // Two-character queries take the LIKE path. `\n` must find the memory
        // containing a literal backslash-n, not every memory containing an `n`.
        let conn = make_memory_db();
        let literal = insert_memory_with_content(&conn, r"join lines with \n here", 1000);
        insert_memory_with_content(&conn, "nothing special", 2000);
        insert_memory_with_content(&conn, r"the tree lives under C:\Users\dev", 3000);

        let rows =
            get_memories(&conn, None, None, None, None, Some(r"\n"), 100, 0).expect("get_memories");
        assert_eq!(rows.iter().map(|m| m.id).collect::<Vec<_>>(), vec![literal]);

        // A Windows path whose FTS tokens match nothing exactly falls back to
        // LIKE, which must also treat the backslash literally.
        let rows = get_memories(&conn, None, None, None, None, Some(r"C:\Users\de"), 100, 0)
            .expect("get_memories");
        assert_eq!(rows.len(), 1, "windows path search: {rows:?}");
        assert!(rows[0].content.contains(r"C:\Users\dev"));
    }

    #[test]
    fn a_page_past_the_fts_results_does_not_switch_to_like_results() {
        let conn = make_memory_db();
        for i in 0..3 {
            insert_memory_with_content(&conn, &format!("alpha fact {i}"), 1000 + i);
        }
        // LIKE '%alpha%' also matches these; FTS's whole-token match does not.
        for i in 0..3 {
            insert_memory_with_content(&conn, &format!("alphabet soup {i}"), 2000 + i);
        }

        let page = |offset| {
            get_memories(&conn, None, None, None, None, Some("alpha"), 2, offset)
                .expect("get_memories")
                .into_iter()
                .map(|m| m.content)
                .collect::<Vec<_>>()
        };
        let mut seen = page(0);
        seen.extend(page(2));
        assert_eq!(seen.len(), 3);
        assert!(seen.iter().all(|c| c.starts_with("alpha fact")), "{seen:?}");
        assert_eq!(page(4), Vec::<String>::new());

        // With no FTS match at all, every page comes from LIKE consistently.
        let like_page = |offset| {
            get_memories(&conn, None, None, None, None, Some("phabe"), 2, offset)
                .expect("get_memories")
                .len()
        };
        assert_eq!((like_page(0), like_page(2), like_page(4)), (2, 1, 0));
    }

    /// Insert a memory with an explicit ID; the store's insert trigger indexes
    /// it for full-text search as ck-mc's writes are indexed.
    fn insert_memory_row(
        conn: &Connection,
        id: i64,
        project_path: &str,
        category: &str,
        status: &str,
        content: &str,
    ) {
        conn.execute(
            "INSERT INTO memories
                (id, level, owner_id, category, origin_category, content, normalized_hash,
                 source_type, seen_count, retrieval_count,
                 first_seen_at, last_seen_at, verification_status,
                 status, created_at, updated_at)
             VALUES (?1, 'project', ?2, ?3, ?4, ?5, ?6,
                     'historian', 1, 0,
                     1000, 1000, 'unverified',
                     ?7, 1000, ?8)",
            (
                id,
                project_path,
                super::schema_fixture::category_id(category),
                category,
                content,
                format!("{:x}", md5::compute(content)),
                status,
                1000 + id,
            ),
        )
        .expect("insert memory");
    }

    fn search_ids(
        conn: &Connection,
        project: Option<&str>,
        status: Option<&str>,
        category: Option<&str>,
        search: &str,
        limit: i64,
        offset: i64,
    ) -> Vec<i64> {
        get_memories(
            conn,
            project,
            None,
            status,
            category,
            Some(search),
            limit,
            offset,
        )
        .expect("get_memories")
        .into_iter()
        .map(|m| m.id)
        .collect()
    }

    #[test]
    fn parse_memory_id_query_accepts_only_a_bare_or_hashed_id() {
        assert_eq!(parse_memory_id_query(Some("1451")), Some(1451));
        assert_eq!(parse_memory_id_query(Some("#1451")), Some(1451));
        assert_eq!(parse_memory_id_query(Some("  #1451 \t")), Some(1451));
        for text in [
            "",
            "#",
            "# 1451",
            "1451a",
            "#14 51",
            "-5",
            "+5",
            "##5",
            "memory 5",
            "99999999999999999999",
        ] {
            assert_eq!(parse_memory_id_query(Some(text)), None, "{text:?}");
        }
        assert_eq!(parse_memory_id_query(None), None);
    }

    #[test]
    fn memory_id_search_returns_exact_memory_with_or_without_hash() {
        let conn = make_memory_db();
        insert_memory_row(
            &conn,
            1451,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "alpha fact",
        );
        insert_memory_row(
            &conn,
            1526,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "beta fact",
        );
        // A two-digit ID takes the LIKE text path rather than FTS.
        insert_memory_row(&conn, 42, "/tmp/ids", "CONSTRAINTS", "active", "gamma fact");

        for search in ["1451", "#1451", "  #1451  "] {
            assert_eq!(
                search_ids(&conn, None, None, None, search, 200, 0),
                vec![1451],
                "{search:?}"
            );
        }
        for search in ["42", "#42"] {
            assert_eq!(
                search_ids(&conn, None, None, None, search, 200, 0),
                vec![42],
                "{search:?}"
            );
        }
    }

    #[test]
    fn memory_id_search_puts_exact_match_first_without_duplicating_text_hits() {
        let conn = make_memory_db();
        // The memory's own text also contains its ID, so the text search
        // returns it too; it must appear exactly once, in first place. Its
        // text is long so FTS ranks it below the short hits: without the ID
        // lookup it would not come first.
        insert_memory_row(
            &conn,
            1451,
            "/tmp/ids",
            "WORKFLOW",
            "active",
            "decision kept after a long discussion about release timing, review load, \
             and several unrelated follow-ups, recorded as 1451",
        );
        insert_memory_row(
            &conn,
            1526,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "1451 1451",
        );
        insert_memory_row(
            &conn,
            1600,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "1451 again",
        );
        insert_memory_row(
            &conn,
            1700,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "unrelated",
        );

        for search in ["1451", "#1451"] {
            // Pin the premise: text ranking alone puts 1451 last.
            let text_only: Vec<i64> = query_memories(
                &conn,
                None,
                None,
                None,
                None,
                Some(search),
                None,
                false,
                200,
                0,
            )
            .expect("text search")
            .into_iter()
            .map(|m| m.id)
            .collect();
            assert_eq!(text_only.len(), 3, "{search:?}: {text_only:?}");
            assert_eq!(text_only.last(), Some(&1451), "{search:?}: {text_only:?}");

            let all = search_ids(&conn, None, None, None, search, 200, 0);
            assert_eq!(all[0], 1451, "{search:?}: {all:?}");
            let mut rest = all[1..].to_vec();
            rest.sort_unstable();
            assert_eq!(rest, vec![1526, 1600], "{search:?}: {all:?}");

            // Pages walk the same combined list: the exact match is on the
            // first page only, and no row is repeated or skipped.
            let mut paged = search_ids(&conn, None, None, None, search, 2, 0);
            assert_eq!(paged.len(), 2);
            paged.extend(search_ids(&conn, None, None, None, search, 2, 2));
            assert_eq!(paged, all, "{search:?}");
            assert!(search_ids(&conn, None, None, None, search, 2, 4).is_empty());
            assert_eq!(
                search_ids(&conn, None, None, None, search, 1, 0),
                vec![1451]
            );
        }
    }

    #[test]
    fn memory_id_search_stays_on_fts_when_the_exact_match_is_the_only_hit() {
        // FTS matches only memory 1451 itself. Showing it as the exact match
        // must not leave the text part empty and trigger the LIKE fallback,
        // which would add the substring-only hit on "14510".
        let conn = make_memory_db();
        insert_memory_row(
            &conn,
            1451,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "note 1451 here",
        );
        insert_memory_row(
            &conn,
            1460,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "ticket 14510",
        );

        assert_eq!(
            search_ids(&conn, None, None, None, "1451", 200, 0),
            vec![1451]
        );
        assert!(search_ids(&conn, None, None, None, "1451", 1, 1).is_empty());
    }

    #[test]
    fn memory_id_search_does_not_override_view_filters() {
        let conn = make_memory_db();
        insert_memory_row(
            &conn,
            1451,
            "/tmp/ids-a",
            "WORKFLOW",
            "archived",
            "old rule",
        );
        insert_memory_row(
            &conn,
            1526,
            "/tmp/ids-a",
            "CONSTRAINTS",
            "active",
            "see 1451",
        );
        insert_memory_row(&conn, 2000, "/tmp/ids-b", "CONSTRAINTS", "active", "other");
        insert_memory_row(
            &conn,
            2001,
            "/tmp/ids-a",
            "CONSTRAINTS",
            "active",
            "cites 2000",
        );

        // Status: 1451 is archived, so an active-only view shows text hits only.
        assert_eq!(
            search_ids(&conn, None, Some("active"), None, "#1451", 200, 0),
            vec![1526]
        );
        // Category: 1451 is WORKFLOW, so a CONSTRAINTS view shows text hits only.
        assert_eq!(
            search_ids(&conn, None, None, Some("CONSTRAINTS"), "1451", 200, 0),
            vec![1526]
        );
        // Project: 2000 lives in another project.
        let project_a = stable_dir_identity("/tmp/ids-a");
        assert_eq!(
            search_ids(&conn, Some(&project_a), None, None, "#2000", 200, 0),
            vec![2001]
        );
        // Matching filters still surface the exact match first.
        assert_eq!(
            search_ids(
                &conn,
                Some(&project_a),
                Some("archived"),
                None,
                "1451",
                200,
                0
            ),
            vec![1451]
        );
        let project_b = stable_dir_identity("/tmp/ids-b");
        assert_eq!(
            search_ids(
                &conn,
                Some(&project_b),
                None,
                Some("CONSTRAINTS"),
                "#2000",
                200,
                0
            ),
            vec![2000]
        );
    }

    #[test]
    fn memory_id_search_for_a_missing_id_returns_text_results_only() {
        let conn = make_memory_db();
        insert_memory_row(
            &conn,
            10,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "see 9999 later",
        );
        insert_memory_row(&conn, 11, "/tmp/ids", "CONSTRAINTS", "active", "unrelated");

        assert_eq!(
            search_ids(&conn, None, None, None, "9999", 200, 0),
            vec![10]
        );
        assert_eq!(
            search_ids(&conn, None, None, None, "#9999", 200, 0),
            vec![10]
        );
        assert!(search_ids(&conn, None, None, None, "#8888", 200, 0).is_empty());
    }

    #[test]
    fn ordinary_text_search_is_unaffected_by_id_lookup() {
        let conn = make_memory_db();
        insert_memory_row(&conn, 1, "/tmp/ids", "CONSTRAINTS", "active", "alpha fact");
        insert_memory_row(
            &conn,
            2,
            "/tmp/ids",
            "CONSTRAINTS",
            "active",
            "memory 1 alpha",
        );
        insert_memory_row(&conn, 3, "/tmp/ids", "CONSTRAINTS", "active", "beta");

        let mut alpha = search_ids(&conn, None, None, None, "alpha", 200, 0);
        alpha.sort_unstable();
        assert_eq!(alpha, vec![1, 2]);
        // Text that merely contains a number is not an ID lookup: memory 1 is
        // not pulled in ahead of the text match.
        assert_eq!(
            search_ids(&conn, None, None, None, "memory 1", 200, 0),
            vec![2]
        );
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
        super::schema_fixture::context_db_in_memory()
    }

    fn insert_memory(conn: &Connection, id: i64, status: &str, created: i64, updated: i64) {
        conn.execute(
            "INSERT INTO memories (id, level, owner_id, category, origin_category, content,
                 normalized_hash, status, first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'project', 'dir:proj', 'swe:project-rules', 'PROJECT_RULES', ?2, ?2, ?3,
                 ?4, ?4, ?5, ?5)",
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
        // The change shows the tag the memory was written under.
        assert_eq!(detail.written[0].category, "PROJECT_RULES");
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

#[cfg(test)]
mod broca_cache_tests {
    use super::*;

    fn store() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE export_facts (export_seq INTEGER PRIMARY KEY, fact_id TEXT UNIQUE,
                                        run_id TEXT NOT NULL, segment_json TEXT NOT NULL);
             CREATE TABLE export_meta (id INTEGER PRIMARY KEY, source_instance_id TEXT, source_epoch INTEGER);
             INSERT INTO export_meta VALUES (1, 'synthetic-db-tests', 1);",
        )
        .unwrap();
        conn
    }

    fn insert(
        conn: &Connection,
        fact: &str,
        run: &str,
        identity: &serde_json::Value,
        ts: i64,
        usage: serde_json::Value,
    ) {
        let segment = serde_json::json!({
            "run_id": run, "session": identity, "provider": "anthropic", "model": "claude",
            "occurred_at_ms": ts, "usage": usage,
        });
        conn.execute(
            "INSERT INTO export_facts (fact_id, run_id, segment_json) VALUES (?1, ?2, ?3)",
            params![fact, run, segment.to_string()],
        )
        .unwrap();
    }

    fn identity(session: &str) -> serde_json::Value {
        serde_json::json!({"project_root": "/work", "harness": "broca", "session": session})
    }

    #[test]
    fn broca_timeline_endpoints_refuse_the_host_without_reading_storage() {
        for result in [
            get_session_cache_events(Harness::Broca, "fixture", None, None),
            get_session_cache_events_by_turn_count(Harness::Broca, "fixture", 10),
        ] {
            let error = result.unwrap_err();
            assert_eq!(
                serde_json::to_value(error).unwrap(),
                serde_json::json!({ "kind": "unsupported_harness", "harness": "broca" })
            );
        }
    }

    #[test]
    fn broca_store_is_opened_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run-index.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE export_facts (run_id TEXT);")
            .unwrap();
        let conn = open_broca_store(&path).unwrap();
        assert!(conn
            .execute("INSERT INTO export_facts VALUES ('run')", [])
            .is_err());
        assert!(open_broca_store(&dir.path().join("missing.db")).is_err());
    }

    #[test]
    fn broca_export_undated_session_remains_listed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.db");
        std::fs::copy(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/broca-export-facts/fixture-run-index.db"
            ),
            &path,
        )
        .unwrap();
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch(
                "INSERT INTO export_facts (fact_id, run_id, segment_json)
            SELECT 'undated-regression', 'undated-run', json_set(segment_json,
                '$.session.session', 'undated-regression', '$.occurred_at_ms', NULL)
            FROM export_facts WHERE export_seq = 1;",
            )
            .unwrap();
        let reader = open_broca_store(&path).unwrap();
        assert!(
            reader.execute("DELETE FROM export_facts", []).is_err(),
            "the production opener must be read-only"
        );
        let listed = load_broca_cache_sessions_from_conn(&reader, 10).unwrap();
        assert_eq!(listed.len(), 5, "undated finished work must not disappear");
        assert_eq!(
            listed.last().unwrap().title.as_deref(),
            Some("undated-regression")
        );
        assert!(reader.is_autocommit());
    }

    #[test]
    fn every_broca_session_is_listed_and_managed() {
        let conn = store();
        let usage = serde_json::json!({"input_tokens": 1, "cached_input_tokens": 0});
        for (fact, session, ts) in [
            ("f1", "mc-historian:one", 1_000),
            ("f2", "alfonso:bg_mason", 2_000),
            ("f3", "alfonso:gather-x", 3_000),
            ("f4", "prefrontal:head", 4_000),
        ] {
            insert(&conn, fact, fact, &identity(session), ts, usage.clone());
        }
        let sessions = load_broca_cache_sessions_from_conn(&conn, 10).unwrap();
        let titles: Vec<_> = sessions.iter().filter_map(|s| s.title.as_deref()).collect();
        assert_eq!(
            titles,
            [
                "prefrontal:head",
                "alfonso:gather-x",
                "alfonso:bg_mason",
                "mc-historian:one"
            ]
        );
        let none = HashSet::new();
        for session in &sessions {
            assert!(is_managed_cache_session(
                Harness::Broca,
                &session.session_id,
                &none
            ));
        }
        assert_eq!(
            load_broca_cache_sessions_from_conn(&conn, 2).unwrap().len(),
            2
        );
    }
}

#[cfg(test)]
mod converted_opencode_store_tests {
    use super::*;

    fn fixture(v1: bool, v2: bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT NOT NULL);
            INSERT INTO project VALUES ('p', 'converted', '/tmp/converted');",
        )
        .unwrap();
        if v1 {
            conn.execute_batch("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                title TEXT NOT NULL, directory TEXT NOT NULL, time_updated INTEGER NOT NULL,
                time_archived INTEGER, parent_id TEXT);
                CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                time_created INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
                session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
                INSERT INTO session VALUES ('old', 'p', 'old v1', '/tmp/converted', 100, NULL, NULL);
                INSERT INTO session VALUES ('shared', 'p', 'shared v1', '/tmp/converted', 100, NULL, NULL);
                INSERT INTO message VALUES ('m_old', 'old', 100, '{\"role\":\"assistant\",\"tokens\":{\"total\":2}}');
                INSERT INTO message VALUES ('m_shared', 'shared', 100, '{\"role\":\"assistant\",\"tokens\":{\"total\":2}}');
                INSERT INTO part VALUES ('part_old','m_old','old',100,'{\"type\":\"text\",\"text\":\"legacy\"}');").unwrap();
        }
        if v2 {
            // A converted database retains the legacy tables and copies session
            // IDs into session_v2. Here `old` has no matching V2 row, while
            // `shared` does, so both ownership paths remain observable.
            conn.execute_batch("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                title TEXT, directory TEXT NOT NULL, time_updated INTEGER NOT NULL,
                time_archived INTEGER, parent_id TEXT);
                CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL, data TEXT NOT NULL);
                INSERT INTO session_v2 VALUES ('shared','p','shared v2','/tmp/converted',200,NULL,NULL);
                INSERT INTO session_v2 VALUES ('new','p','new v2','/tmp/converted',300,NULL,NULL);
                INSERT INTO session_message VALUES ('m2','new','assistant',1,300,300,
                    '{\"role\":\"assistant\",\"tokens\":{\"input\":3,\"output\":2,\"cache\":{\"read\":1,\"write\":1}},\"content\":\"v2\"}');").unwrap();
        }
        conn
    }

    #[test]
    fn converted_store_merges_new_old_and_shared_sessions_with_v2_ownership() {
        let conn = fixture(true, true);
        let resolved = resolve_opencode_sessions(&conn).unwrap();
        assert_eq!(
            resolved.generations,
            vec![OpenCodeStoreGeneration::V1, OpenCodeStoreGeneration::V2]
        );
        assert_eq!(resolved.owners.len(), 3);
        assert_eq!(resolved.owner("old"), Some(OpenCodeStoreGeneration::V1));
        assert_eq!(resolved.owner("shared"), Some(OpenCodeStoreGeneration::V2));
        assert_eq!(resolved.owner("new"), Some(OpenCodeStoreGeneration::V2));
        let mut env = crate::test_env::EnvGuard::new();
        let root = tempfile::tempdir().unwrap();
        env.set("XDG_DATA_HOME", root.path());
        env.set("XDG_CONFIG_HOME", root.path());
        env.set("XDG_STATE_HOME", root.path());
        env.set("XDG_RUNTIME_DIR", root.path());
        env.set("MAGIC_CONTEXT_STORAGE_DIR", root.path());
        env.set("OPENCODE_DB", root.path().join("opencode.db"));
        let rows: Vec<_> = resolved
            .generations
            .iter()
            .flat_map(|&generation| {
                list_opencode_sessions_for_generation(
                    &conn,
                    &ReadableStore::for_tests(root.path().join("opencode.db")),
                    &resolved,
                    generation,
                    &SessionFilter::default(),
                )
            })
            .collect();
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "shared")
                .unwrap()
                .title,
            "shared v2"
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "new")
                .unwrap()
                .harness,
            Harness::Opencode2
        );
        let cache_rows: Vec<_> = resolved
            .generations
            .iter()
            .flat_map(|&generation| {
                load_recent_opencode_cache_sessions_from_conn(
                    &conn,
                    generation,
                    10,
                    &HashSet::new(),
                )
                .into_iter()
                .filter(|row| resolved.owns(&row.session_id, generation))
                .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(cache_rows.len(), 2);
        assert!(cache_rows.iter().any(|row| row.session_id == "new"));
        let messages =
            load_opencode_messages(&conn, resolved.owner("new").unwrap(), "new").unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].message_id, "m2");
        let cache = get_opencode_session_cache_events_from_conn(
            &conn,
            resolved.owner("new").unwrap(),
            "new",
            None,
            None,
        );
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[0].harness, Harness::Opencode2);
    }

    #[test]
    fn pure_generations_keep_their_original_owners_and_message_sources() {
        let v1 = fixture(true, false);
        let v2 = fixture(false, true);
        let first = resolve_opencode_sessions(&v1).unwrap();
        let second = resolve_opencode_sessions(&v2).unwrap();
        assert_eq!(first.generations, vec![OpenCodeStoreGeneration::V1]);
        assert_eq!(second.generations, vec![OpenCodeStoreGeneration::V2]);
        assert_eq!(first.owner("old"), Some(OpenCodeStoreGeneration::V1));
        assert_eq!(second.owner("new"), Some(OpenCodeStoreGeneration::V2));
        assert_eq!(
            load_opencode_messages(&v1, OpenCodeStoreGeneration::V1, "old").unwrap()[0]
                .text_preview,
            "legacy"
        );
        assert_eq!(
            load_opencode_messages(&v2, OpenCodeStoreGeneration::V2, "new")
                .unwrap()
                .len(),
            1
        );
    }
}
