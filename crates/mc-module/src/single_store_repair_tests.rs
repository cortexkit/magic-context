//! Tests of the history repair after a single-store migration.
//!
//! The fixture writes the pair as the migration's backup holds it (a `context.db` whose
//! session reaches sequence 4, a `store.db` that stopped at sequence 2 with sequence 2
//! written differently), then derives the live pair the old migration rule left: the
//! store's sequence 2 in place, sequences 3 and 4 deleted with their events, embeddings
//! and candidates, and two compartments the historian re-summarised since.

use super::*;
use sha2::{Digest, Sha256};

const SCHEMA_SNAPSHOT: &str = include_str!("../tests/fixtures/context-db-schema.sql");
const SESSION: &str = "ses_lost";
const OTHER: &str = "ses_untouched";
const PROJECT: &str = "git:subc";
const NOW: i64 = 1_900_000_000_000;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    live_context: PathBuf,
    live_store: PathBuf,
    backup: PathBuf,
}

fn open_rw(path: &Path) -> Connection {
    Connection::open(path).unwrap()
}

fn compartment(
    conn: &Connection,
    id: i64,
    sequence: i64,
    start: i64,
    end: i64,
    title: &str,
    created: i64,
) {
    conn.execute(
        "INSERT INTO compartments(id, session_id, sequence, start_message, end_message,
             start_message_id, end_message_id, title, content, p1, importance, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 50, ?10)",
        params![
            id,
            SESSION,
            sequence,
            start,
            end,
            format!("m{start}"),
            format!("m{end}"),
            title,
            format!("{title} body"),
            created
        ],
    )
    .unwrap();
}

fn event(conn: &Connection, id: i64, compartment: i64, kind: &str) {
    conn.execute(
        "INSERT INTO compartment_events(id, session_id, compartment_id, kind, fields_json, created_at)
         VALUES (?1, ?2, ?3, ?4, '{}', 1)",
        params![id, SESSION, compartment, kind],
    )
    .unwrap();
}

fn embedding(conn: &Connection, compartment: i64) {
    conn.execute(
        "INSERT INTO compartment_chunk_embeddings(compartment_id, session_id, project_path,
             start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at)
         VALUES (?1, ?2, ?3, 1, 2, ?4, 'model', 2, x'0000', 1)",
        params![compartment, SESSION, PROJECT, format!("hash-{compartment}")],
    )
    .unwrap();
}

fn candidate(conn: &Connection, id: i64, start: i64, end: i64) {
    conn.execute(
        "INSERT INTO user_memory_candidates(id, content, session_id, source_compartment_start, source_compartment_end, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        params![id, format!("candidate {id}"), SESSION, start, end],
    )
    .unwrap();
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let backup = root.join("backup");
        std::fs::create_dir_all(&backup).unwrap();

        // The backup's context.db: TypeScript kept writing the session up to sequence 4.
        let context = open_rw(&backup.join("context.db"));
        context.execute_batch(SCHEMA_SNAPSHOT).unwrap();
        context
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS single_store_state (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL,
                     migrated_at INTEGER, migrated_by TEXT, backup_dir TEXT, report_json TEXT);
                 INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required');
                 INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', 'uuid-1');",
            )
            .unwrap();
        context
            .execute(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES (?1, 'opencode', ?2, 1)",
                params![SESSION, PROJECT],
            )
            .unwrap();
        compartment(&context, 10, 0, 1, 10, "zero", 100);
        compartment(&context, 11, 1, 11, 20, "one", 100);
        compartment(&context, 12, 2, 21, 30, "two by typescript", 200);
        compartment(&context, 13, 3, 31, 40, "three", 300);
        compartment(&context, 14, 4, 41, 50, "four", 400);
        for id in 10..=14 {
            event(&context, 90 + id, id, "original");
        }
        embedding(&context, 13);
        embedding(&context, 14);
        candidate(&context, 200, 3, 3);
        candidate(&context, 201, 0, 0);
        // A session the migration never touched, which the live file no longer has.
        context
            .execute(
                "INSERT INTO compartments(id, session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES (50, ?1, 0, 1, 99, 'deleted since', 'body', 1)",
                params![OTHER],
            )
            .unwrap();
        drop(context);

        // The backup's store.db stopped at sequence 2, written differently.
        let store_backup = backup.join("store.db");
        mc_store::migrate_store_to_pre_single_store(&store_backup).unwrap();
        let store = open_rw(&store_backup);
        for (sequence, start, end, title) in [
            (0, 1, 10, "zero"),
            (1, 11, 20, "one"),
            (2, 21, 25, "two by the module"),
        ] {
            store
                .execute(
                    "INSERT INTO mc_compartments(session_id, sequence, start_message, end_message,
                         start_message_id, end_message_id, title, content, p1, importance, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 50, 100)",
                    params![SESSION, sequence, start, end, format!("m{start}"), format!("m{end}"), title, format!("{title} body")],
                )
                .unwrap();
        }
        drop(store);

        // The live pair: the migration put the store's version of sequence 2 in place and
        // deleted sequences 3 and 4; the historian then wrote two new compartments over
        // the same messages.
        let live_context = root.join("context.db");
        let live_store = root.join("store.db");
        std::fs::copy(backup.join("context.db"), &live_context).unwrap();
        std::fs::copy(&store_backup, &live_store).unwrap();
        let live = open_rw(&live_context);
        live.execute_batch(&format!(
            "UPDATE single_store_state SET state = 'migrated', migrated_at = 1 WHERE id = 1;
             UPDATE compartments SET start_block_index = 0, end_block_index = 2 WHERE id = 10;
             UPDATE compartments SET title = 'two by the module', content = 'two by the module body',
                    p1 = 'two by the module body', end_message = 25, end_message_id = 'm25', created_at = 100
              WHERE id = 12;
             DELETE FROM compartment_chunk_embeddings WHERE compartment_id IN (13, 14);
             DELETE FROM compartment_events WHERE compartment_id IN (12, 13, 14);
             DELETE FROM compartments WHERE id IN (13, 14);
             DELETE FROM compartments WHERE session_id = '{OTHER}';
             DELETE FROM user_memory_candidates WHERE id = 200;"
        ))
        .unwrap();
        event(&live, 105, 12, "copied from the store");
        compartment(&live, 20, 3, 26, 45, "re-summarised three", 900);
        compartment(&live, 21, 4, 46, 48, "re-summarised four", 900);
        event(&live, 106, 20, "re-summarised");
        embedding(&live, 20);
        candidate(&live, 202, 3, 4);
        live.execute(
            "INSERT INTO session_meta(session_id, cached_m0_bytes, cached_m1_bytes, cached_m0_max_compartment_seq,
                 cached_m0_last_baseline_end_message_id, pending_compaction_marker_state, memory_block_cache, compaction_marker_state)
             VALUES (?1, x'01', x'02', 4, 'm45', '{\"ordinal\":48}', 'memories', '{\"boundaryOrdinal\":50}')",
            params![SESSION],
        )
        .unwrap();
        drop(live);
        let store = open_rw(&live_store);
        store
            .execute_batch(mc_store::single_store_schema::MIGRATION_61_CREATE_SQL)
            .unwrap();
        for sequence in 0..=4 {
            store
                .execute(
                    "INSERT INTO mc_compartment_dates(session_id, sequence, start_date, end_date) VALUES (?1, ?2, 'd', 'd')",
                    params![SESSION, sequence],
                )
                .unwrap();
        }
        store
            .execute(
                "INSERT INTO mc_cache_state(session_id, row_version, core_state, meta, last_activity_at)
                 VALUES (?1, 1, '{}', '{\"initialized\":true}', 1)",
                params![SESSION],
            )
            .unwrap();
        drop(store);
        Fixture {
            _dir: dir,
            root,
            live_context,
            live_store,
            backup,
        }
    }

    fn options(&self) -> RepairOptions {
        let mut options = RepairOptions::new(
            self.live_context.clone(),
            self.live_store.clone(),
            self.backup.clone(),
        );
        options.now_ms = NOW;
        options
    }

    fn apply(&self) -> RepairReport {
        let mut options = self.options();
        options.apply = true;
        options.backup_dir = Some(self.root.join("repair-backup"));
        run(&options).expect("repair")
    }

    fn live(&self) -> Connection {
        open_rw(&self.live_context)
    }

    fn ids(&self, sql: &str) -> Vec<i64> {
        self.live()
            .prepare(sql)
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// Every row of every table of the live pair and the backup, hashed.
    fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        for path in [
            &self.live_context,
            &self.live_store,
            &self.backup.join("context.db"),
            &self.backup.join("store.db"),
        ] {
            let conn = open_rw(path);
            let tables: Vec<String> = conn
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            for table in tables {
                let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
                let width = statement.column_count();
                let mut rows: Vec<String> = statement
                    .query_map([], |row| {
                        (0..width)
                            .map(|index| {
                                row.get::<_, SqlValue>(index)
                                    .map(|value| format!("{value:?}"))
                            })
                            .collect::<Result<Vec<_>, _>>()
                            .map(|values| values.join("|"))
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                rows.sort();
                hasher.update(table.as_bytes());
                for row in rows {
                    hasher.update(row.as_bytes());
                }
            }
        }
        format!("{:x}", hasher.finalize())
    }
}

/// The `session_meta` columns the repair clears, then the marker state it keeps.
type SessionMetaAfter = (
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    Option<i64>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);

fn expect_refusal(result: Result<RepairReport, EngineError>, code: &str) {
    match result {
        Err(EngineError::Refused(refusal)) => assert_eq!(refusal.code, code, "{refusal:?}"),
        other => panic!("expected {code}, got {other:?}"),
    }
}

#[test]
fn the_preview_names_the_truncated_session_and_writes_nothing() {
    let fixture = Fixture::new();
    let before = fixture.digest();
    let report = run(&fixture.options()).unwrap();
    assert_eq!(fixture.digest(), before);
    assert_eq!(report.status, "preview");
    assert_eq!(
        report.sessions.len(),
        1,
        "the session deleted since is not offered"
    );
    let plan = &report.sessions[0];
    assert_eq!(plan.session, SESSION);
    assert_eq!(plan.project.as_deref(), Some(PROJECT));
    assert_eq!(
        (plan.backup.compartments, plan.backup.end_message),
        (5, Some(50))
    );
    assert_eq!(
        (plan.live.compartments, plan.live.end_message),
        (5, Some(48))
    );
    // Sequence 0 only gained the block indexes the migration filled in: still kept.
    assert_eq!(
        (plan.kept, plan.restored, plan.removed, plan.tail),
        (2, 3, 3, 0)
    );
    assert_eq!(plan.removed_sequences, Some((2, 4)));
    assert_eq!(
        plan.compartment_events,
        RowChange {
            restored: 3,
            removed: 2
        }
    );
    assert_eq!(
        plan.chunk_embeddings,
        RowChange {
            restored: 2,
            removed: 1
        }
    );
    assert_eq!(
        plan.user_memory_candidates,
        RowChange {
            restored: 1,
            removed: 1
        }
    );
    assert_eq!(
        plan.after,
        Extent {
            compartments: 5,
            max_sequence: Some(4),
            end_message: Some(50)
        }
    );
}

#[test]
fn apply_restores_the_backup_history_with_its_ids_and_dependents() {
    let fixture = Fixture::new();
    let report = fixture.apply();
    assert_eq!(report.status, "repaired");
    let live = fixture.live();
    let rows: Vec<(i64, i64, i64, String)> = live
        .prepare("SELECT id, sequence, end_message, title FROM compartments WHERE session_id = ?1 ORDER BY sequence")
        .unwrap()
        .query_map(params![SESSION], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (10, 0, 10, "zero".into()),
            (11, 1, 20, "one".into()),
            (12, 2, 30, "two by typescript".into()),
            (13, 3, 40, "three".into()),
            (14, 4, 50, "four".into()),
        ]
    );
    assert_eq!(
        fixture.ids("SELECT id FROM compartment_events ORDER BY id"),
        vec![100, 101, 102, 103, 104],
        "the backup's events are back; the store copy and the re-summarised row's are gone"
    );
    assert_eq!(
        fixture
            .ids("SELECT compartment_id FROM compartment_chunk_embeddings ORDER BY compartment_id"),
        vec![13, 14]
    );
    assert_eq!(
        fixture.ids("SELECT id FROM user_memory_candidates ORDER BY id"),
        vec![200, 201]
    );
    let meta: SessionMetaAfter = live
        .query_row(
            "SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_max_compartment_seq, cached_m0_last_baseline_end_message_id,
                    pending_compaction_marker_state, memory_block_cache, compaction_marker_state
               FROM session_meta WHERE session_id = ?1",
            params![SESSION],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
        )
        .unwrap();
    assert_eq!(
        meta,
        (
            None,
            None,
            None,
            None,
            None,
            String::new(),
            Some("{\"boundaryOrdinal\":50}".into())
        ),
        "cached m[0] and the pending marker move are cleared; the host's marker state is kept"
    );
    assert_eq!(
        fixture
            .ids("SELECT COUNT(*) FROM m0_mutation_log WHERE mutation_type = 'compartment_delete'"),
        vec![1]
    );
    let store = open_rw(&fixture.live_store);
    let dates: Vec<i64> = store
        .prepare(
            "SELECT sequence FROM mc_compartment_dates WHERE session_id = ?1 ORDER BY sequence",
        )
        .unwrap()
        .query_map(params![SESSION], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(dates, vec![0, 1], "dates of the restored range are dropped");
    let meta: String = store
        .query_row(
            "SELECT meta FROM mc_cache_state WHERE session_id = ?1",
            params![SESSION],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        meta.contains("\"project_memory_epoch_pending\":true"),
        "{meta}"
    );
    assert!(fixture.root.join("repair-backup/MANIFEST.tsv").exists());
    // A second preview has nothing left to do.
    assert!(run(&fixture.options()).unwrap().sessions.is_empty());
}

#[test]
fn compartments_past_the_backup_end_are_kept_and_renumbered() {
    let fixture = Fixture::new();
    let live = fixture.live();
    live.execute_batch("DELETE FROM compartments WHERE id = 21; DELETE FROM user_memory_candidates WHERE id = 202;")
        .unwrap();
    compartment(&live, 22, 4, 51, 60, "new after the backup", 950);
    drop(live);
    let report = fixture.apply();
    assert_eq!(report.sessions[0].tail, 1);
    let tail: (i64, String) = fixture
        .live()
        .query_row(
            "SELECT sequence, title FROM compartments WHERE id = 22",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(tail, (5, "new after the backup".into()));
}

#[test]
fn a_named_session_the_migration_did_not_move_is_reported_as_not_needed() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options.sessions = vec![OTHER.into()];
    let report = run(&options).unwrap();
    assert!(report.sessions.is_empty());
    assert_eq!(report.not_needed, vec![OTHER.to_string()]);
}

#[test]
fn a_session_with_a_historian_run_in_progress_refuses_and_is_left_unchanged() {
    let fixture = Fixture::new();
    fixture
        .live()
        .execute(
            "UPDATE session_meta SET compartment_in_progress = 1 WHERE session_id = ?1",
            params![SESSION],
        )
        .unwrap();
    let rows_before = fixture.ids("SELECT id FROM compartments ORDER BY id");
    let mut options = fixture.options();
    options.apply = true;
    options.backup_dir = Some(fixture.root.join("b"));
    expect_refusal(run(&options), SESSION_BUSY);
    assert_eq!(
        fixture.ids("SELECT id FROM compartments ORDER BY id"),
        rows_before
    );
}

#[test]
fn an_unmigrated_live_file_refuses() {
    let fixture = Fixture::new();
    fixture
        .live()
        .execute("UPDATE single_store_state SET state = 'required'", [])
        .unwrap();
    expect_refusal(run(&fixture.options()), NOT_MIGRATED);
}

#[test]
fn a_backup_of_another_file_refuses() {
    let fixture = Fixture::new();
    fixture
        .live()
        .execute(
            "UPDATE context_store_meta SET value = 'uuid-2' WHERE key = 'store_uuid'",
            [],
        )
        .unwrap();
    expect_refusal(run(&fixture.options()), BACKUP_MISMATCH);
}

#[test]
fn the_command_line_needs_a_backup_dir_to_apply() {
    let base: Vec<String> = [
        "--context-db",
        "c",
        "--store-db",
        "s",
        "--from-backup",
        "b",
        "--session",
        "x",
        "--apply",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    assert!(parse_args(&base).is_err());
    let mut with_dir = base.clone();
    with_dir.extend(["--backup-dir".to_string(), "d".to_string()]);
    let options = parse_args(&with_dir).unwrap();
    assert_eq!(options.sessions, vec!["x".to_string()]);
    assert!(options.apply);
}

/// The session_meta columns the repair clears: upgrade state, m[0] and m[1] bytes,
/// and the visible-memory manifest (ids and count).
type ClearedCachedPair = (
    Option<String>,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
    String,
    i64,
);

#[test]
fn repair_discards_typescript_memory_ids_with_the_cached_pair() {
    let fixture = Fixture::new();
    let live = fixture.live();
    live.execute(
        "UPDATE session_meta SET cached_m0_upgrade_state = ?2, memory_block_ids = '[1,2]', memory_block_count = 2 WHERE session_id = ?1",
        params![SESSION, "ready|compartment-render:cre2|memory-render:mre3|m0-memory-ids:[1]"],
    ).unwrap();
    drop(live);

    fixture.apply();
    let live = fixture.live();
    let cleared: ClearedCachedPair = live.query_row(
        "SELECT cached_m0_upgrade_state, cached_m0_bytes, cached_m1_bytes, memory_block_ids, memory_block_count FROM session_meta WHERE session_id = ?1",
        params![SESSION],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).unwrap();
    assert_eq!(cleared, (None, None, None, String::new(), 0));
    let store = open_rw(&fixture.live_store);
    let meta: String = store
        .query_row(
            "SELECT meta FROM mc_cache_state WHERE session_id = ?1",
            params![SESSION],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&meta).unwrap()["project_memory_epoch_pending"],
        true
    );
}

#[test]
fn rust_module_keeps_typescript_upgrade_metadata_out_of_render_identity() {
    use syn::visit::{self, Visit};

    // Inspect literals and macro tokens, not comments. The sole permitted reference
    // is the cache-clear constant; a SQL reader in any other production item fails.
    #[derive(Default)]
    struct References {
        constant: String,
        sites: Vec<String>,
    }
    impl<'ast> Visit<'ast> for References {
        fn visit_attribute(&mut self, _attribute: &'ast syn::Attribute) {}
        fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
            if item.attrs.iter().any(|attr| {
                attr.path().is_ident("cfg")
                    && attr
                        .parse_args::<syn::Path>()
                        .is_ok_and(|path| path.is_ident("test"))
            }) {
                return;
            }
            visit::visit_item_mod(self, item);
        }
        fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
            if item.attrs.iter().any(|attr| attr.path().is_ident("test")) {
                return;
            }
            visit::visit_item_fn(self, item);
        }
        fn visit_item_const(&mut self, item: &'ast syn::ItemConst) {
            let previous = std::mem::replace(&mut self.constant, item.ident.to_string());
            visit::visit_item_const(self, item);
            self.constant = previous;
        }
        fn visit_lit_str(&mut self, literal: &'ast syn::LitStr) {
            for _ in literal.value().matches("cached_m0_upgrade_state") {
                self.sites.push(self.constant.clone());
            }
        }
        fn visit_macro(&mut self, value: &'ast syn::Macro) {
            for _ in value.tokens.to_string().matches("cached_m0_upgrade_state") {
                self.sites.push(self.constant.clone());
            }
        }
    }
    fn sources(directory: &Path, output: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                if path.file_name().unwrap() != "tests" {
                    sources(&path, output);
                }
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let name = path.file_name().unwrap().to_str().unwrap();
                if !name.ends_with("_test.rs") && !name.ends_with("_tests.rs") {
                    output.push(path);
                }
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut paths = Vec::new();
    sources(&root, &mut paths);
    assert!(
        paths.len() > 20,
        "the production-source scan must not be empty"
    );
    let mut found = Vec::new();
    for path in paths {
        let parsed = syn::parse_file(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut references = References::default();
        references.visit_file(&parsed);
        found.extend(
            references
                .sites
                .into_iter()
                .map(|site| (path.strip_prefix(&root).unwrap().to_path_buf(), site)),
        );
    }
    assert_eq!(
        found,
        vec![(
            PathBuf::from("single_store_repair.rs"),
            "SESSION_META_RESETS".to_string()
        )]
    );
}
