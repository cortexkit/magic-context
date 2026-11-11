//! Tests for reading more than one OpenCode store: the store list, the rules
//! for opening a store another process owns, and the readers that merge
//! stores.

use super::opencode_stores::{
    configured_store_path, open_store, parse_runner_roots, read_store, sqlite_file_uri,
    store_list_for, RunnerRoots, StoreOpenError, StoreOrigin,
};
use super::*;
use std::fs;
use std::path::{Path, PathBuf};

// ── Fixtures ──────────────────────────────────────────────────────────────

/// An OpenCode 2 store with the tables the dashboard reads. `sessions` are
/// `(id, title, updated)`; each gets one assistant message with tokens.
fn opencode2_store(path: &Path, sessions: &[(&str, &str, i64)]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT, worktree TEXT NOT NULL);
         CREATE TABLE session_v2 (
             id TEXT PRIMARY KEY, title TEXT, project_id TEXT, parent_id TEXT,
             directory TEXT NOT NULL DEFAULT '', time_updated INTEGER NOT NULL,
             time_archived INTEGER);
         CREATE TABLE session_message (
             id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
             seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
             time_updated INTEGER NOT NULL, data TEXT NOT NULL);
         CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);",
    )
    .unwrap();
    for (id, title, updated) in sessions {
        conn.execute(
            "INSERT INTO session_v2 (id, title, time_updated) VALUES (?1, ?2, ?3)",
            params![id, title, updated],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_message VALUES (?1, ?2, 'assistant', 1, ?3, ?3, ?4)",
            params![
                format!("m-{id}"),
                id,
                updated,
                r#"{"role":"assistant","tokens":{"input":10,"output":2,"cache":{"read":5,"write":1}}}"#
            ],
        )
        .unwrap();
    }
}

/// A throwaway data, config and storage root, set as this process's
/// folders for the length of a test. Nothing here reads the user's own
/// stores or config.
struct Root {
    _env: crate::test_env::EnvGuard,
    dir: tempfile::TempDir,
}

impl Root {
    fn new() -> Self {
        let mut env = crate::test_env::EnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        for folder in ["data", "config", "state", "storage", "pi"] {
            fs::create_dir_all(dir.path().join(folder)).unwrap();
        }
        env.set("XDG_DATA_HOME", dir.path().join("data"));
        env.set("XDG_CONFIG_HOME", dir.path().join("config"));
        env.set("XDG_STATE_HOME", dir.path().join("state"));
        env.set("MAGIC_CONTEXT_STORAGE_DIR", dir.path().join("storage"));
        env.remove("OPENCODE_DB");
        env.remove("OPENCODE_CHANNEL");
        env.remove("OPENCODE_DISABLE_CHANNEL_DB");
        Connection::open(dir.path().join("storage").join("context.db"))
            .unwrap()
            .execute_batch(
                "CREATE TABLE session_meta (
                     session_id TEXT PRIMARY KEY,
                     harness TEXT NOT NULL DEFAULT 'opencode',
                     is_subagent INTEGER DEFAULT 0);",
            )
            .unwrap();
        crate::pi_sessions::clear_caches_for_tests();
        crate::pi_sessions::set_test_root_for_tests(dir.path().join("pi"));
        Self { _env: env, dir }
    }

    fn data_home(&self) -> PathBuf {
        self.dir.path().join("data")
    }

    fn default_store(&self) -> PathBuf {
        self.data_home().join("opencode").join("opencode.db")
    }

    fn runner_folder(&self) -> PathBuf {
        self.dir.path().join("runner").join("opencode2-server")
    }

    fn write_roots(&self, json: &serde_json::Value) {
        let path = runner_roots_path(&self.data_home());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(json).unwrap()).unwrap();
    }

    fn write_user_config(&self, text: &str) {
        let path = crate::config::resolve_user_config_path(&self.dir.path().join("config"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

impl Drop for Root {
    fn drop(&mut self) {
        crate::pi_sessions::clear_caches_for_tests();
    }
}

fn roots_json(folder: &Path, sessions: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "written_by": "a field this reader does not know",
        "roots": [{
            "path": folder,
            "kind": "shared",
            "sessions": sessions,
        }],
    })
}

fn ids(rows: &[SessionRow]) -> Vec<&str> {
    let mut ids: Vec<&str> = rows.iter().map(|row| row.session_id.as_str()).collect();
    ids.sort_unstable();
    ids
}

// ── The list ──────────────────────────────────────────────────────────────

#[test]
fn the_list_is_default_then_runner_then_configured() {
    let root = tempfile::tempdir().unwrap();
    let data_home = root.path().join("data");
    let default = data_home.join("opencode").join("opencode.db");
    let runner = root.path().join("runner");
    let configured = root.path().join("configured");
    opencode2_store(&default, &[]);
    opencode2_store(&runner.join("opencode.db"), &[]);
    opencode2_store(&configured.join("opencode.db"), &[]);
    let roots = RunnerRoots::Roots(vec![super::opencode_stores::RunnerRoot {
        store: runner.join("opencode.db"),
        helpers: Default::default(),
    }]);

    let (rows, readable) = store_list_for(
        &data_home,
        &OpenCodeDbOverrides::default(),
        &roots,
        // A folder is accepted as well as the file inside it.
        &[configured.to_string_lossy().to_string()],
    );

    let origins: Vec<StoreOrigin> = rows.iter().map(|row| row.origin).collect();
    assert_eq!(
        origins,
        vec![
            StoreOrigin::Default,
            StoreOrigin::Runner,
            StoreOrigin::Configured
        ]
    );
    assert!(rows
        .iter()
        .all(|row| row.found && row.read && row.note.is_none()));
    let paths: Vec<PathBuf> = readable.into_iter().map(|store| store.path).collect();
    assert_eq!(
        paths,
        vec![
            default,
            runner.join("opencode.db"),
            configured.join("opencode.db")
        ]
    );
    assert_eq!(
        rows[2].configured_value.as_deref(),
        Some(configured.to_string_lossy().as_ref())
    );
}

#[test]
fn a_store_listed_twice_is_read_once() {
    let root = tempfile::tempdir().unwrap();
    let data_home = root.path().join("data");
    let default = data_home.join("opencode").join("opencode.db");
    opencode2_store(&default, &[]);
    let roots = RunnerRoots::Roots(vec![super::opencode_stores::RunnerRoot {
        store: default.clone(),
        helpers: Default::default(),
    }]);
    let (rows, readable) = store_list_for(
        &data_home,
        &OpenCodeDbOverrides::default(),
        &roots,
        &[
            default.to_string_lossy().to_string(),
            default.parent().unwrap().to_string_lossy().to_string(),
        ],
    );
    assert_eq!(readable.len(), 1, "{rows:?}");
    assert_eq!(readable[0].origin, StoreOrigin::Default);
    assert_eq!(rows.len(), 4);
    for row in &rows[1..] {
        assert!(row.found && !row.read, "{row:?}");
        assert!(
            row.note
                .as_deref()
                .unwrap()
                .contains("Same file as the default store"),
            "{row:?}"
        );
    }
}

#[test]
fn a_missing_configured_path_is_reported_and_skipped() {
    let root = tempfile::tempdir().unwrap();
    let data_home = root.path().join("data");
    opencode2_store(&data_home.join("opencode").join("opencode.db"), &[]);
    let missing = root.path().join("gone").join("opencode.db");
    let (rows, readable) = store_list_for(
        &data_home,
        &OpenCodeDbOverrides::default(),
        &RunnerRoots::Absent,
        &[missing.to_string_lossy().to_string()],
    );
    assert_eq!(readable.len(), 1);
    assert_eq!(rows[1].origin, StoreOrigin::Configured);
    assert!(!rows[1].found && !rows[1].read);
    assert_eq!(rows[1].note.as_deref(), Some("Not found."));
    assert_eq!(rows[1].path, missing.to_string_lossy());
}

#[test]
fn relative_and_token_paths_are_refused() {
    for raw in [
        "opencode.db",
        "./stores/opencode.db",
        "~/stores/opencode.db",
        "",
    ] {
        assert!(configured_store_path(raw).is_err(), "{raw:?} was accepted");
    }
    let token = configured_store_path("{env:HOME}/opencode.db").unwrap_err();
    assert!(token.contains("{env:}"), "{token}");
    assert!(configured_store_path("/abs/{file:x}").is_err());
    let relative = configured_store_path("stores/opencode.db").unwrap_err();
    assert!(relative.contains("absolute"), "{relative}");
    #[cfg(windows)]
    assert!(configured_store_path(r"C:\Users\me\opencode.db").is_ok());
    #[cfg(not(windows))]
    assert!(configured_store_path("/srv/opencode.db").is_ok());

    // A refused value is listed with its reason and never read.
    let root = tempfile::tempdir().unwrap();
    let (rows, readable) = store_list_for(
        root.path(),
        &OpenCodeDbOverrides::default(),
        &RunnerRoots::Absent,
        &["relative/opencode.db".to_string()],
    );
    assert!(readable.is_empty());
    assert!(!rows[1].read);
    assert!(rows[1].note.as_deref().unwrap().contains("absolute"));
}

// ── roots.json ────────────────────────────────────────────────────────────

#[test]
fn roots_json_is_read_tolerantly() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("roots.json");
    assert_eq!(parse_runner_roots(&path), RunnerRoots::Absent);

    let folder = root.path().join("server");
    fs::write(
        &path,
        serde_json::to_vec(&roots_json(
            &folder,
            serde_json::json!([
                {"session": "ses-mc", "session_ref": "r1", "owner_principal": "magic-context",
                 "state": "live", "done_at_ms": null, "future_field": [1, 2]},
                {"session": "ses-core", "session_ref": "r2", "owner_principal": "prefrontal-core",
                 "state": "done", "done_at_ms": 5, "imported_through_seq": 9},
            ]),
        ))
        .unwrap(),
    )
    .unwrap();
    let RunnerRoots::Roots(roots) = parse_runner_roots(&path) else {
        panic!("unknown fields must be ignored");
    };
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].store, folder.join("opencode.db"));
    assert_eq!(
        roots[0].helpers.iter().collect::<Vec<_>>(),
        vec!["ses-mc"],
        "only Magic Context's own sessions are helpers"
    );

    fs::write(&path, r#"{"version": 2, "roots": []}"#).unwrap();
    let RunnerRoots::Unusable(reason) = parse_runner_roots(&path) else {
        panic!("an unknown version must mean no runner stores");
    };
    assert!(reason.contains("version 2"), "{reason}");

    fs::write(&path, "{ not json").unwrap();
    assert!(matches!(
        parse_runner_roots(&path),
        RunnerRoots::Unusable(_)
    ));

    // Present but unreadable: a folder where the file should be.
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(matches!(
        parse_runner_roots(&path),
        RunnerRoots::Unusable(_)
    ));
}

#[test]
fn an_unusable_roots_json_lists_no_runner_store_and_fails_nothing() {
    let root = Root::new();
    opencode2_store(&root.default_store(), &[("ses-own", "own", 100)]);
    opencode2_store(
        &root.runner_folder().join("opencode.db"),
        &[("ses-run", "run", 200)],
    );
    root.write_roots(&serde_json::json!({"version": 7, "roots": [{"path": root.runner_folder()}]}));
    let rows = opencode_store_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].origin, StoreOrigin::Default);
    assert_eq!(
        ids(&list_opencode_sessions(&SessionFilter::default())),
        vec!["ses-own"]
    );
}

// ── Rules for a store another process owns ────────────────────────────────

fn side(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
        .unwrap()
}

/// A WAL-mode store whose owner is still running: every row is still in the
/// WAL, none checkpointed into the main file.
fn running_wal_store(path: &Path, rows: i64) -> Connection {
    let writer = Connection::open(path).unwrap();
    writer
        .execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x);",
        )
        .unwrap();
    for x in 0..rows {
        writer.execute("INSERT INTO t VALUES (?1)", [x]).unwrap();
    }
    writer
}

#[test]
fn a_store_with_wal_files_is_opened_normally_and_sees_rows_still_in_the_wal() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("opencode.db");
    let _writer = running_wal_store(&path, 3);
    assert!(side(&path, "-wal").exists() && side(&path, "-shm").exists());
    // Opened immutable, the reader would see the main file only, where the
    // table does not exist yet.
    let store = open_store(&path).unwrap();
    assert_eq!(count(&store.conn), 3);
}

#[test]
fn a_store_without_wal_files_is_read_without_creating_any() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("opencode.db");
    // The owner stopped cleanly: its last close checkpointed and removed both
    // side files, and the file is still in WAL mode.
    drop(running_wal_store(&path, 2));
    assert!(!side(&path, "-wal").exists() && !side(&path, "-shm").exists());
    let bytes = fs::read(&path).unwrap();

    let value = read_store(&path, count).unwrap();

    assert_eq!(value, 2);
    assert!(
        !side(&path, "-wal").exists() && !side(&path, "-shm").exists(),
        "reading a stopped store must leave no WAL files in its owner's folder"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn a_store_with_exactly_one_wal_file_is_skipped_and_said_so() {
    for (present, absent) in [("-wal", "-shm"), ("-shm", "-wal")] {
        let root = tempfile::tempdir().unwrap();
        let data_home = root.path().join("data");
        let path = data_home.join("opencode").join("opencode.db");
        opencode2_store(&path, &[]);
        fs::write(side(&path, present), b"").unwrap();

        let Err(StoreOpenError::Refused(reason)) = open_store(&path) else {
            panic!("a store with only {present} must not be opened");
        };
        assert!(reason.contains(present), "{reason}");
        assert!(
            !side(&path, absent).exists(),
            "opening it would have created {absent}"
        );

        let (rows, readable) = store_list_for(
            &data_home,
            &OpenCodeDbOverrides::default(),
            &RunnerRoots::Absent,
            &[],
        );
        assert!(readable.is_empty());
        assert!(rows[0].found && !rows[0].read);
        assert_eq!(rows[0].note.as_deref(), Some(reason.as_str()));
    }
}

#[test]
fn a_read_of_an_immutable_store_that_changed_meanwhile_is_discarded() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("opencode.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (zeroblob(100));")
        .unwrap();
    let mut attempts = 0;
    let value = read_store(&path, |conn| {
        attempts += 1;
        let seen = count(conn);
        if attempts == 1 {
            // Another process writes while this read is under way. The new
            // row is large enough to grow the file by several pages.
            Connection::open(&path)
                .unwrap()
                .execute("INSERT INTO t VALUES (zeroblob(20000))", [])
                .unwrap();
        }
        seen
    })
    .unwrap();
    assert_eq!(attempts, 2, "the first read saw a change and was discarded");
    assert_eq!(value, 2, "the result comes from the read after the change");
}

#[test]
fn reading_a_store_never_checkpoints_its_wal() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("opencode.db");
    let writer = running_wal_store(&path, 4);
    // The owner closes without checkpointing (as a crashed or killed server
    // would), leaving both side files and every row in the WAL.
    writer
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            true,
        )
        .unwrap();
    drop(writer);
    let wal_len = fs::metadata(side(&path, "-wal")).unwrap().len();
    assert!(wal_len > 0);
    let main = fs::read(&path).unwrap();

    // This reader is the last connection to close.
    assert_eq!(read_store(&path, count).unwrap(), 4);

    assert_eq!(
        fs::metadata(side(&path, "-wal")).map(|m| m.len()).ok(),
        Some(wal_len),
        "the WAL must be left exactly as the owner left it"
    );
    assert_eq!(fs::read(&path).unwrap(), main, "the main file was written");
}

#[test]
fn paths_with_uri_characters_open_immutable() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("a b#c%d?e").join("opencode.db");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
        .unwrap();
    assert!(sqlite_file_uri(&path).contains("a%20b%23c%25d%3Fe"));
    assert_eq!(read_store(&path, count).unwrap(), 1);
    assert_eq!(
        sqlite_file_uri(Path::new("C:/x y/o.db")),
        "file:/C:/x%20y/o.db"
    );
    assert_eq!(
        sqlite_file_uri(Path::new("//server/share/o.db")),
        "file:////server/share/o.db"
    );
}

// ── Readers over the list ─────────────────────────────────────────────────

#[test]
fn two_stores_merge_in_the_session_list_cache_list_and_cache_events() {
    let root = Root::new();
    opencode2_store(&root.default_store(), &[("ses-own", "own", 100)]);
    opencode2_store(
        &root.runner_folder().join("opencode.db"),
        &[("ses-run", "run", 200)],
    );
    root.write_roots(&roots_json(&root.runner_folder(), serde_json::json!([])));

    assert_eq!(
        ids(&list_opencode_sessions(&SessionFilter::default())),
        vec!["ses-own", "ses-run"]
    );

    let mut cached: Vec<String> =
        get_session_cache_stats_from_db(10, true, false, Some(Harness::Opencode2))
            .into_iter()
            .map(|row| row.session_id)
            .collect();
    cached.sort();
    assert_eq!(cached, vec!["ses-own", "ses-run"]);

    let mut event_sessions: Vec<String> = load_raw_db_cache_events(50, None)
        .unwrap()
        .into_iter()
        .map(|event| event.session_id)
        .collect();
    event_sessions.sort();
    assert_eq!(event_sessions, vec!["ses-own", "ses-run"]);

    let titles = load_cache_session_titles(&HashSet::from([
        (Harness::Opencode2, "ses-own".to_string()),
        (Harness::Opencode2, "ses-run".to_string()),
    ]));
    assert_eq!(titles.len(), 2);

    // One session's events come from the store that holds it.
    let events = get_session_cache_events(Harness::Opencode2, "ses-run", None, None);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].message_id, "m-ses-run");
}

#[test]
fn a_session_id_in_two_stores_is_shown_once_from_the_first_store() {
    let root = Root::new();
    opencode2_store(&root.default_store(), &[("ses-dup", "own copy", 100)]);
    let configured = root.dir.path().join("copy").join("opencode.db");
    opencode2_store(&configured, &[("ses-dup", "copied", 900)]);
    root.write_user_config(&format!(
        "{{\n  // extra stores\n  \"dashboard\": {{ \"opencode_db_paths\": [{}] }},\n}}",
        serde_json::to_string(&configured).unwrap()
    ));
    assert_eq!(opencode_store_rows().len(), 2);
    let rows = list_opencode_sessions(&SessionFilter::default());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "own copy");
    let events = get_session_cache_events(Harness::Opencode2, "ses-dup", None, None);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].timestamp, 100,
        "the first store answers the lookup"
    );
}

#[test]
fn magic_context_sessions_in_a_runner_store_are_flagged_as_helpers() {
    let root = Root::new();
    let sessions = [
        ("ses-mc", "summarizer", 300),
        ("ses-core", "agent", 200),
        ("ses-unlisted", "not in roots.json", 100),
    ];
    opencode2_store(&root.runner_folder().join("opencode.db"), &sessions);
    root.write_roots(&roots_json(
        &root.runner_folder(),
        serde_json::json!([
            {"session": "ses-mc", "owner_principal": "magic-context"},
            {"session": "ses-core", "owner_principal": "prefrontal-core"},
        ]),
    ));

    let flagged: Vec<(String, bool)> = {
        let mut rows: Vec<_> = list_opencode_sessions(&SessionFilter::default())
            .into_iter()
            .map(|row| (row.session_id, row.is_subagent))
            .collect();
        rows.sort();
        rows
    };
    assert_eq!(
        flagged,
        vec![
            ("ses-core".to_string(), false),
            ("ses-mc".to_string(), true),
            ("ses-unlisted".to_string(), false),
        ]
    );
    let mut shown: Vec<String> =
        get_session_cache_stats_from_db(10, true, true, Some(Harness::Opencode2))
            .into_iter()
            .map(|row| row.session_id)
            .collect();
    shown.sort();
    assert_eq!(shown, vec!["ses-core", "ses-unlisted"]);
}

#[test]
fn the_same_ids_in_a_store_not_found_through_roots_json_are_not_flagged() {
    let root = Root::new();
    let sessions = [("ses-mc", "summarizer", 300), ("ses-core", "agent", 200)];
    let configured = root.dir.path().join("configured").join("opencode.db");
    opencode2_store(&configured, &sessions);
    opencode2_store(&root.default_store(), &[("ses-own", "own", 100)]);
    // roots.json names these sessions, but for a root that is not the
    // configured store (and holds no store at all).
    root.write_roots(&roots_json(
        &root.dir.path().join("elsewhere"),
        serde_json::json!([{"session": "ses-mc", "owner_principal": "magic-context"}]),
    ));
    root.write_user_config(&format!(
        "{{ \"dashboard\": {{ \"opencode_db_paths\": [{}] }} }}",
        serde_json::to_string(&configured).unwrap()
    ));

    let rows = list_opencode_sessions(&SessionFilter::default());
    assert_eq!(ids(&rows), vec!["ses-core", "ses-mc", "ses-own"]);
    assert!(rows.iter().all(|row| !row.is_subagent), "{rows:?}");
    let shown = get_session_cache_stats_from_db(10, true, true, Some(Harness::Opencode2));
    assert_eq!(shown.len(), 3, "{shown:?}");
}
