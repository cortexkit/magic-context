//! Tests of the offline single-store migration engine.
//!
//! The fixture builds `store.db` through the real migration chain to version 60 and
//! `context.db` from the committed schema snapshot plus the v92 flag table, then fills
//! both with the shapes the migration has to reconcile. Each test runs the engine on its
//! own copy and asserts one property, so breaking one mechanism reddens one test.

use super::*;
use std::path::Path;

const SCHEMA_SNAPSHOT: &str = include_str!("../tests/fixtures/context-db-schema.sql");
const FILE_UUID: &str = "uuid-this-file";
const STORE_PROJECT: &str = "git:store-wins";
const CONTEXT_PROJECT: &str = "git:context-wins";
const SESSION: &str = "ses_store";
const NOW: i64 = 1_800_000_000_000;

/// The v92 migration as the design specifies it; the TypeScript lane owns the real one.
const V92_SQL: &str = "
CREATE TABLE IF NOT EXISTS single_store_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    state         TEXT NOT NULL CHECK (state IN ('required', 'migrated')),
    migrated_at   INTEGER,
    migrated_by   TEXT,
    backup_dir    TEXT,
    report_json   TEXT
);
INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required');
INSERT OR IGNORE INTO schema_migrations(version, description, applied_at) VALUES (92, 'single_store_state', 0);
";

/// Which optional shapes a fixture carries on top of the common one.
#[derive(Default, Clone, Copy)]
struct Extras {
    /// Context-only events of every fate, and a superseded context candidate.
    history_fates: bool,
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    context_db: PathBuf,
    store_db: PathBuf,
}

impl Fixture {
    fn new(extras: Extras) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let context_db = root.join("context.db");
        let store_db = root.join("store.db");
        mc_store::migrate_store_to_pre_single_store(&store_db).unwrap();
        let context = Connection::open(&context_db).unwrap();
        context.execute_batch(SCHEMA_SNAPSHOT).unwrap();
        context
            .execute_batch(
                "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0);
                 INSERT OR IGNORE INTO schema_migrations(version, description, applied_at) VALUES (91, 'fixture', 0);",
            )
            .unwrap();
        context.execute_batch(V92_SQL).unwrap();
        context
            .execute(
                "INSERT INTO context_store_meta(key, value) VALUES ('store_uuid', ?1)",
                params![FILE_UUID],
            )
            .unwrap();
        let fixture = Fixture {
            _dir: dir,
            root,
            context_db,
            store_db,
        };
        fixture.populate(extras);
        fixture
    }

    fn store(&self) -> Connection {
        Connection::open(&self.store_db).unwrap()
    }

    fn context(&self) -> Connection {
        Connection::open(&self.context_db).unwrap()
    }

    fn populate(&self, extras: Extras) {
        let store = self.store();
        let context = self.context();
        // Seed the context rows as the mirror would have, past the authority guards.
        context
            .execute(
                "UPDATE context_privilege_state SET enabled = 1 WHERE id = 1",
                [],
            )
            .unwrap();
        // Who owns what: the store owns one project, the other was never handed over.
        for domain in ["memories", "notes"] {
            store
                .execute(
                    "INSERT INTO mc_authority(context_store_uuid, project, domain, state)
                     VALUES (?1, ?2, ?3, 'MODULE')",
                    params![FILE_UUID, STORE_PROJECT, domain],
                )
                .unwrap();
        }
        context
            .execute(
                "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?1, ?2, 1)",
                params![STORE_PROJECT, FILE_UUID],
            )
            .unwrap();
        context
            .execute(
                "INSERT INTO session_projects(session_id, harness, project_path, updated_at)
                 VALUES (?1, 'opencode', ?2, 1)",
                params![SESSION, STORE_PROJECT],
            )
            .unwrap();

        // Context twins. Ids are explicit so references can be checked by number: 5, 6 and
        // 7 are the store-wins project's twins, 8 a row whose store source the module
        // deleted, 1 the context-wins project's twin.
        let context_memory = |id: i64, project: &str, content: &str, hash: &str, seen: i64| {
            context
                .execute(
                    "INSERT INTO memories(id, project_path, category, content, normalized_hash, seen_count,
                                          first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, ?2, 'CONSTRAINTS', ?3, ?4, ?5, 1000, 1000, 1000, 1000)",
                    params![id, project, content, hash, seen],
                )
                .unwrap();
        };
        context_memory(1, CONTEXT_PROJECT, "context variant", "h-c1", 1);
        context_memory(5, STORE_PROJECT, "stale one", "h-s1-old", 1);
        context_memory(6, STORE_PROJECT, "stale two", "h-s2-old", 1);
        context_memory(7, STORE_PROJECT, "three", "h-s3", 1);
        context_memory(8, STORE_PROJECT, "deleted by the module", "h-gone", 1);
        context
            .execute_batch(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
                 VALUES ('memories', 'git:store-wins', 1, 5), ('memories', 'git:store-wins', 99, 8);",
            )
            .unwrap();

        // Store memories. 1 pairs through its identity row, 2 through the context id it was
        // seeded from, 3 through its natural key; 4 and 5 exist only here, 4 superseded by 5
        // and merged from 1 and 5. 6 pairs with the context-wins twin, 7 is store-only there.
        let store_memory = |id: i64, project: &str, content: &str, hash: &str, seen: i64| {
            store
                .execute(
                    "INSERT INTO mc_memories(id, project_path, category, content, normalized_hash, seen_count,
                                             first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, ?2, 'CONSTRAINTS', ?3, ?4, ?5, 1000, 1000, 2000, 1000)",
                    params![id, project, content, hash, seen],
                )
                .unwrap();
        };
        store_memory(1, STORE_PROJECT, "store one", "h-s1", 3);
        store_memory(2, STORE_PROJECT, "store two", "h-s2", 3);
        store_memory(3, STORE_PROJECT, "three", "h-s3", 9);
        store_memory(4, STORE_PROJECT, "store four", "h-s4", 1);
        store_memory(5, STORE_PROJECT, "store five", "h-s5", 1);
        store_memory(6, CONTEXT_PROJECT, "store variant", "h-c1", 4);
        store_memory(7, CONTEXT_PROJECT, "store seven", "h-c7", 1);
        store
            .execute_batch(&format!(
                "UPDATE mc_memories SET context_store_uuid = '{FILE_UUID}', context_row_id = 6 WHERE id = 2;
                 UPDATE mc_memories SET superseded_by_memory_id = 5, merged_from = '[1,5]', status = 'archived' WHERE id = 4;"
            ))
            .unwrap();
        store
            .execute_batch(
                "INSERT INTO mc_memory_mappings(memory_id, project_path, mapped_files_json, updated_at)
                 VALUES (4, 'git:store-wins', '[\"a.rs\",\"b.rs\"]', 4000),
                        (5, 'git:store-wins', 'null', 4000),
                        (98, 'git:store-wins', '[\"gone.rs\"]', 4000);
                 UPDATE mc_privilege_state SET note_caller_project = 'git:store-wins' WHERE id = 1;
                 INSERT INTO mc_notes(type, project_path, session_id, content, status, created_at_ms, updated_at_ms)
                 VALUES ('session', 'git:store-wins', 'ses_store', 'a surfacing note', 'surfacing', 3000, 3000);
                 UPDATE mc_privilege_state SET note_caller_project = '' WHERE id = 1;",
            )
            .unwrap();

        // Session history: the context holds a stale copy of sequence 2 and an extra 3.
        let store_compartment = |sequence: i64, start: i64, end: i64, title: &str, date: &str| {
            store
                .execute(
                    "INSERT INTO mc_compartments(session_id, sequence, start_message, end_message,
                         start_message_id, end_message_id, title, content, p1, importance, created_at,
                         start_date, end_date)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 50, 1000, ?9, ?9)",
                    params![
                        SESSION,
                        sequence,
                        start,
                        end,
                        format!("m{start}"),
                        format!("m{end}"),
                        title,
                        format!("{title} body"),
                        date
                    ],
                )
                .unwrap();
        };
        store_compartment(1, 1, 5, "first", "2026-01-01");
        store_compartment(2, 6, 10, "second rewritten", "2026-01-02");
        let context_compartment = |id: i64, sequence: i64, start: i64, end: i64, title: &str| {
            context
                .execute(
                    "INSERT INTO compartments(id, session_id, sequence, start_message, end_message,
                         start_message_id, end_message_id, title, content, p1, importance, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 50, 1000)",
                    params![
                        id,
                        SESSION,
                        sequence,
                        start,
                        end,
                        format!("m{start}"),
                        format!("m{end}"),
                        title,
                        format!("{title} body")
                    ],
                )
                .unwrap();
        };
        context_compartment(101, 1, 1, 5, "first");
        context_compartment(102, 2, 6, 10, "second original");
        context_compartment(103, 3, 11, 15, "third");
        store
            .execute(
                "INSERT INTO mc_compartment_events(session_id, compartment_id, kind, fields_json, created_at)
                 VALUES (?1, 2, 'decision', '{}', 1000)",
                params![SESSION],
            )
            .unwrap();
        if extras.history_fates {
            context
                .execute_batch(
                    "INSERT INTO compartment_events(id, session_id, compartment_id, kind, fields_json, created_at)
                     VALUES (201, 'ses_store', 101, 'kept', '{}', 1),
                            (202, 'ses_store', 102, 'superseded', '{}', 1),
                            (203, 'ses_store', 9999, 'orphan', '{}', 1);
                     INSERT INTO user_memory_candidates(id, content, session_id, source_compartment_start, source_compartment_end, created_at)
                     VALUES (301, 'from the rewritten compartment', 'ses_store', 2, 2, 1);",
                )
                .unwrap();
        }

        // Cache state of a recently active session, with store-space ids in it.
        let meta = json!({
            "initialized": true,
            "rendered_memory_ids": [1, 2, 3],
            "max_memory_id": 7,
            "memory_mutation_cursor": 4,
            "m1_revision": 3,
            "expiry_cutoff_ms": NOW,
            "last_serializer_profile": "opencode-aisdk",
            "revert_epoch": 2,
        });
        store
            .execute(
                "INSERT INTO mc_cache_state(session_id, row_version, core_state, meta, last_activity_at)
                 VALUES (?1, 4, '{}', ?2, ?3)",
                params![SESSION, meta.to_string(), NOW - 1000],
            )
            .unwrap();
        context
            .execute(
                "UPDATE context_privilege_state SET enabled = 0 WHERE id = 1",
                [],
            )
            .unwrap();
    }

    fn options(&self, backup: &str) -> EngineOptions {
        let mut options = EngineOptions::new(
            self.context_db.clone(),
            self.store_db.clone(),
            self.root.join(backup),
        );
        options.check_context_path = false;
        options.now_ms = NOW;
        options.render_seed = 7;
        options.build = "test-build".into();
        options
    }

    fn migrate(&self) -> Report {
        run(&self.options("backup"), &mut NoHooks).expect("migration")
    }

    /// A logical dump of every table of both files, plus both version rows, hashed.
    fn digest(&self) -> String {
        let mut hasher = Sha256::new();
        for path in [&self.context_db, &self.store_db] {
            let conn = Connection::open(path).unwrap();
            let tables: Vec<String> = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table'
                       AND name NOT LIKE 'sqlite_stat%' ORDER BY name",
                )
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            for table in tables {
                hasher.update(table.as_bytes());
                let mut statement = conn.prepare(&format!("SELECT * FROM \"{table}\"")).unwrap();
                let mut columns: Vec<String> = statement
                    .column_names()
                    .into_iter()
                    .map(str::to_owned)
                    .collect();
                columns.sort();
                let mut rows: Vec<String> = statement
                    .query_map([], |row| {
                        let mut values = Vec::new();
                        for column in &columns {
                            values.push(format!("{:?}", row.get::<_, SqlValue>(column.as_str())?));
                        }
                        Ok(values.join("|"))
                    })
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                rows.sort();
                for row in rows {
                    hasher.update(row.as_bytes());
                }
            }
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn memory_content(conn: &Connection, id: i64) -> String {
    conn.query_row(
        "SELECT content FROM memories WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

fn context_id_of(conn: &Connection, content: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM memories WHERE content = ?1",
        params![content],
        |row| row.get(0),
    )
    .unwrap()
}

fn expect_refusal(result: Result<Report, EngineError>, code: &str) -> Refusal {
    match result {
        Err(EngineError::Refused(refusal)) => {
            assert_eq!(refusal.code, code, "{refusal:?}");
            refusal
        }
        other => panic!("expected refusal {code}, got {other:?}"),
    }
}

// ── 5.1: the step-through migration ────────────────────────────────────────

#[test]
fn store_wins_twin_holds_store_content_and_context_wins_twin_holds_context_content() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let context = fixture.context();
    assert_eq!(memory_content(&context, 5), "store one", "identity twin");
    assert_eq!(memory_content(&context, 6), "store two", "seeded twin");
    let seen: i64 = context
        .query_row("SELECT seen_count FROM memories WHERE id = 7", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(seen, 9, "natural-key twin takes the store's values");
    assert_eq!(
        memory_content(&context, 1),
        "context variant",
        "context-wins twin untouched"
    );
    let deleted: bool = context
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM memories WHERE id = 8)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(deleted, "a row the module had deleted is removed");
    // Store-only rows of both projects are inserted.
    context_id_of(&context, "store seven");
    context_id_of(&context, "store four");
}

#[test]
fn references_name_the_new_ids() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let context = fixture.context();
    let four = context_id_of(&context, "store four");
    let five = context_id_of(&context, "store five");
    let (superseded, merged): (Option<i64>, String) = context
        .query_row(
            "SELECT superseded_by_memory_id, merged_from FROM memories WHERE id = ?1",
            params![four],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(superseded, Some(five));
    assert_eq!(
        merged,
        format!("[5,{five}]"),
        "store 1 is context 5, store 5 is context {five}"
    );
}

/// Seeding copied `merged_from` verbatim from the context row, so a seeded store row whose
/// list still equals its twin's already holds context ids. Translating it as store ids
/// would point it at other memories (here store 1 is context 5, not context 1).
#[test]
fn a_seeded_twins_merged_from_is_already_in_context_ids_and_kept() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET merged_from = '[1]' WHERE id = 2",
            [],
        )
        .unwrap();
    let context = fixture.context();
    context
        .execute_batch(
            "UPDATE context_privilege_state SET enabled = 1;
             UPDATE memories SET merged_from = '[1]' WHERE id = 6;
             UPDATE context_privilege_state SET enabled = 0;",
        )
        .unwrap();
    fixture.migrate();
    let merged: String = fixture
        .context()
        .query_row("SELECT merged_from FROM memories WHERE id = 6", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(merged, "[1]");
}

#[test]
fn a_file_list_becomes_one_unverified_row_per_file_and_null_writes_none() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let context = fixture.context();
    let four = context_id_of(&context, "store four");
    let five = context_id_of(&context, "store five");
    let files: Vec<(String, i64, i64)> = context
        .prepare(
            "SELECT file_path, verified_at, mapped_at FROM memory_verifications
              WHERE memory_id = ?1 ORDER BY file_path",
        )
        .unwrap()
        .query_map(params![four], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        files,
        vec![("a.rs".to_string(), 0, 4000), ("b.rs".to_string(), 0, 4000)]
    );
    let independent: i64 = context
        .query_row(
            "SELECT COUNT(*) FROM memory_verifications WHERE memory_id = ?1",
            params![five],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(independent, 0, "a null file list writes no row");
}

#[test]
fn orphan_event_kept_and_counted_superseded_deleted_unchanged_kept() {
    let fixture = Fixture::new(Extras {
        history_fates: true,
    });
    let report = fixture.migrate();
    let context = fixture.context();
    let ids: Vec<i64> = context
        .prepare("SELECT id FROM compartment_events WHERE id IN (201, 202, 203) ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        ids,
        vec![201, 203],
        "unchanged and orphan kept, superseded deleted"
    );
    let project = report
        .projects
        .iter()
        .find(|entry| entry.project == STORE_PROJECT)
        .unwrap();
    assert_eq!(project.tables["compartment_events"].orphans_kept, 1);
    assert_eq!(project.tables["compartment_events"].deleted, 1);
    let candidate_left: bool = context
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM user_memory_candidates WHERE id = 301)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !candidate_left,
        "a candidate drawn from a rewritten compartment is deleted"
    );
}

#[test]
fn compartment_ids_of_updated_sequences_are_unchanged() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let context = fixture.context();
    let rows: Vec<(i64, i64, String)> = context
        .prepare(
            "SELECT id, sequence, title FROM compartments WHERE session_id = ?1 ORDER BY sequence",
        )
        .unwrap()
        .query_map(params![SESSION], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (101, 1, "first".to_string()),
            (102, 2, "second rewritten".to_string()),
        ],
        "updated in place, extra sequence removed"
    );
    let event_target: i64 = context
        .query_row(
            "SELECT compartment_id FROM compartment_events WHERE kind = 'decision'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        event_target, 102,
        "the store event names the compartment's context id"
    );
    let dates: (String, String) = fixture
        .store()
        .query_row(
            "SELECT start_date, end_message_id FROM mc_compartment_dates WHERE session_id = ?1 AND sequence = 2",
            params![SESSION],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(dates, ("2026-01-02".to_string(), "m10".to_string()));
}

#[test]
fn store_db_is_at_61_with_its_marker_stamped_like_single_store_state() {
    let fixture = Fixture::new(Extras::default());
    let report = fixture.migrate();
    assert_eq!(report.status, "migrated");
    let store = fixture.store();
    assert_eq!(schema::recorded_store_version(&store).unwrap(), 61);
    let (set, stamp, by) = read_store_marker(&store).unwrap();
    assert!(set);
    assert_eq!(stamp, Some(NOW));
    assert_eq!(by, "test-build");
    let context = read_context_state(&fixture.context()).unwrap().unwrap();
    assert_eq!(context.state, "migrated");
    assert_eq!(context.migrated_at, stamp);
    assert_eq!(context.migrated_by.as_deref(), Some("test-build"));
    for table in schema::SINGLE_STORE_DROPPED_TABLES {
        assert!(
            !schema::table_exists(&store, "main", table).unwrap(),
            "{table} dropped"
        );
    }
    let journal: String = store
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal", "WAL mode is restored after the run");
    let left: i64 = fixture
        .context()
        .query_row("SELECT COUNT(*) FROM mirror_identity", [], |row| row.get(0))
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn every_cache_row_is_marked_for_one_hard_with_store_ids_zeroed() {
    let fixture = Fixture::new(Extras::default());
    let report = fixture.migrate();
    assert_eq!(report.sessions_reset, 1);
    let (meta, row_version): (String, i64) = fixture
        .store()
        .query_row(
            "SELECT meta, row_version FROM mc_cache_state WHERE session_id = ?1",
            params![SESSION],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let meta: Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(meta["bootstrap_seed_fold_pending"], true);
    assert_eq!(meta["max_memory_id"], 0);
    assert_eq!(meta["memory_mutation_cursor"], 0);
    assert_eq!(meta["m1_revision"], 0);
    assert_eq!(meta["rendered_memory_ids"], json!([]));
    assert_eq!(meta["revert_epoch"], 2, "the rest of the meta is kept");
    assert_eq!(row_version, 5);
    let epoch: i64 = fixture
        .context()
        .query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path = ?1",
            params![STORE_PROJECT],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(epoch, 1, "the changed project's memory epoch is bumped");
}

#[test]
fn notes_in_module_only_states_arrive_ready() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let status: String = fixture
        .context()
        .query_row(
            "SELECT status FROM notes WHERE content = 'a surfacing note'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(status, "ready");
}

#[test]
fn the_render_check_samples_the_recent_session_and_reports_its_seed() {
    let fixture = Fixture::new(Extras::default());
    let report = fixture.migrate();
    assert_eq!(report.render_check.sampled, 1);
    assert_eq!(report.render_check.passed, 1);
    assert_eq!(report.render_check.seed, 7);
}

#[test]
fn a_second_run_reports_already_migrated_and_writes_nothing() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let before = fixture.digest();
    let report = run(&fixture.options("backup-again"), &mut NoHooks).unwrap();
    assert_eq!(report.status, "already_migrated");
    assert_eq!(report.migrated_at, Some(NOW));
    assert_eq!(fixture.digest(), before);
}

#[test]
fn a_store_upgraded_to_the_latest_schema_remains_recognized_as_migrated() {
    let fixture = Fixture::new(Extras::default());
    fixture.migrate();
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".to_string(),
        storage_namespace: "magic-context".to_string(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: fixture.store_db.to_string_lossy().into_owned(),
        },
    };
    drop(mc_store::McStore::open(&descriptor).unwrap());
    assert_eq!(
        schema::recorded_store_version(&fixture.store()).unwrap(),
        mc_store::LATEST_MIGRATION_VERSION
    );
    let before = fixture.digest();
    let report = run(&fixture.options("backup-again"), &mut NoHooks).unwrap();
    assert_eq!(report.status, "already_migrated");
    assert_eq!(fixture.digest(), before);
}

#[test]
fn a_dry_run_writes_nothing_and_leaves_the_backup_directory_free_for_the_real_run() {
    let fixture = Fixture::new(Extras::default());
    let file_bytes = |path: &Path| {
        let mut hasher = Sha256::new();
        hasher.update(std::fs::read(path).unwrap());
        format!("{:x}", hasher.finalize())
    };
    let before = (
        file_bytes(&fixture.store_db),
        file_bytes(&fixture.context_db),
    );
    let mut options = fixture.options("backup");
    options.dry_run = true;
    let report = run(&options, &mut NoHooks).unwrap();
    assert_eq!(report.status, "dry_run");
    assert!(report
        .projects
        .iter()
        .any(|entry| entry.project == STORE_PROJECT));
    assert_eq!(report.backup_dir, None, "a dry run backs nothing up");
    assert!(
        !fixture.root.join("backup").exists(),
        "a dry run must not create the backup directory the real run needs"
    );
    assert_eq!(
        (
            file_bytes(&fixture.store_db),
            file_bytes(&fixture.context_db)
        ),
        before,
        "a dry run must leave both files byte-for-byte unchanged"
    );
    let leftovers: Vec<_> = std::fs::read_dir(&fixture.root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("dry-run"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "scratch copies removed: {leftovers:?}"
    );

    let real = run(&fixture.options("backup"), &mut NoHooks).unwrap();
    assert_eq!(real.status, "migrated");
}

#[test]
fn the_backup_holds_both_files_and_a_manifest() {
    let fixture = Fixture::new(Extras::default());
    let report = fixture.migrate();
    let backup = PathBuf::from(report.backup_dir.unwrap());
    assert_eq!(backup, fixture.root.join("backup"));
    let manifest = std::fs::read_to_string(backup.join("MANIFEST.tsv")).unwrap();
    assert!(manifest.contains("context.db\t"), "{manifest}");
    assert!(manifest.contains("store.db\t"), "{manifest}");
    let copy = Connection::open(backup.join("store.db")).unwrap();
    let rows: i64 = copy
        .query_row("SELECT COUNT(*) FROM mc_memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 7, "the backup keeps the rows the migration moved");
}

// ── 5.1: refusals leave both files unchanged ───────────────────────────────

fn assert_refused_unchanged(
    fixture: &Fixture,
    options: EngineOptions,
    hooks: &mut dyn EngineHooks,
    code: &str,
) -> Refusal {
    let before = fixture.digest();
    let refusal = expect_refusal(run(&options, hooks), code);
    assert_eq!(fixture.digest(), before, "{code} left both files unchanged");
    refusal
}

#[test]
fn authority_in_transition_refuses_and_names_the_flag() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .store()
        .execute(
            "UPDATE mc_authority SET state = 'PREPARING' WHERE project = ?1 AND domain = 'notes'",
            params![STORE_PROJECT],
        )
        .unwrap();
    let refusal = assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        AUTHORITY_IN_TRANSITION,
    );
    assert!(refusal
        .to_value()
        .to_string()
        .contains("--prefer git:store-wins=store"));
    // The operator's choice moves it.
    let mut options = fixture.options("b2");
    options.prefer.insert(STORE_PROJECT.into(), Winner::Store);
    assert_eq!(run(&options, &mut NoHooks).unwrap().status, "migrated");
}

#[test]
fn foreign_context_refuses_until_skipped() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .store()
        .execute(
            "UPDATE mc_authority SET context_store_uuid = 'uuid-elsewhere'",
            [],
        )
        .unwrap();
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        FOREIGN_CONTEXT,
    );
    let mut options = fixture.options("b2");
    options.skip_foreign = true;
    let report = run(&options, &mut NoHooks).unwrap();
    let skipped = report
        .projects
        .iter()
        .find(|entry| entry.project == STORE_PROJECT)
        .unwrap();
    assert!(skipped.skipped);
    assert_eq!(
        memory_content(&fixture.context(), 5),
        "stale one",
        "a skipped project is left alone"
    );
}

#[test]
fn unclassified_rows_refuse() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .context()
        .execute(
            "INSERT INTO compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES (?1, NULL, 'unknown', '{}', 1)",
            params![SESSION],
        )
        .unwrap();
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        UNCLASSIFIED_ROWS,
    );
}

#[test]
fn unresolved_reference_that_exists_in_the_other_id_space_refuses() {
    let fixture = Fixture::new(Extras::default());
    fixture.context().execute("INSERT INTO memories(id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (777, 'git:unrelated', 'CONSTRAINTS', 'unrelated numeric collision', 'collision', 1, 1, 1, 1)", []).unwrap();
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET superseded_by_memory_id = 777 WHERE id = 5",
            [],
        )
        .unwrap();
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        DANGLING_REFERENCE,
    );
}

#[test]
fn claude_code_ids_refuse_until_accepted() {
    let fixture = Fixture::new(Extras::default());
    // Store memory 5 becomes a new context row, and context id 5 is another memory.
    let meta = json!({"last_serializer_profile": CLAUDE_CODE_PROFILE, "rendered_memory_ids": [5]});
    fixture
        .store()
        .execute(
            "INSERT INTO mc_cache_state(session_id, row_version, core_state, meta, last_activity_at)
             VALUES ('ses_cc', 1, '{}', ?1, 0)",
            params![meta.to_string()],
        )
        .unwrap();
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        CLAUDE_CODE_IDS,
    );
    let mut options = fixture.options("b2");
    options.accept_id_change = true;
    assert_eq!(run(&options, &mut NoHooks).unwrap().status, "migrated");
}

#[test]
fn a_claude_code_id_that_now_names_another_projects_memory_does_not_refuse() {
    let fixture = Fixture::new(Extras::default());
    // Store memory 7 belongs to the context-wins project and moves to a new context id;
    // context id 7 is a memory of the store-wins project. The session's lookups carry its
    // own project, so id 7 reads as "not found" there, not as the wrong memory.
    let meta = json!({"last_serializer_profile": CLAUDE_CODE_PROFILE, "rendered_memory_ids": [7]});
    fixture
        .store()
        .execute(
            "INSERT INTO mc_cache_state(session_id, row_version, core_state, meta, last_activity_at)
             VALUES ('ses_cc', 1, '{}', ?1, 0)",
            params![meta.to_string()],
        )
        .unwrap();
    assert_eq!(
        run(&fixture.options("b"), &mut NoHooks).unwrap().status,
        "migrated"
    );
}

struct CorruptDate;
impl EngineHooks for CorruptDate {
    fn after_copy(&mut self, conn: &Connection) -> Result<(), EngineError> {
        conn.execute(
            "UPDATE main.mc_compartment_dates SET start_date = '1999-12-31' WHERE sequence = 1",
            [],
        )?;
        Ok(())
    }
}

#[test]
fn a_render_mismatch_planted_after_the_copy_refuses() {
    let fixture = Fixture::new(Extras::default());
    let refusal = assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut CorruptDate,
        RENDER_MISMATCH,
    );
    assert!(refusal.message.contains(SESSION), "{}", refusal.message);
}

struct FailAfterCopy;
impl EngineHooks for FailAfterCopy {
    fn after_copy(&mut self, _conn: &Connection) -> Result<(), EngineError> {
        Err(EngineError::Internal(
            "injected failure after the copy".into(),
        ))
    }
}

#[test]
fn an_error_after_the_copy_rolls_both_files_back() {
    let fixture = Fixture::new(Extras::default());
    let before = fixture.digest();
    match run(&fixture.options("b"), &mut FailAfterCopy) {
        Err(EngineError::Internal(message)) => assert!(message.contains("injected")),
        other => panic!("expected the injected failure, got {other:?}"),
    }
    assert_eq!(fixture.digest(), before);
    let journal: String = fixture
        .store()
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(journal, "wal", "WAL mode is restored after a failure too");
}

#[test]
fn an_existing_backup_directory_refuses_before_any_write() {
    let fixture = Fixture::new(Extras::default());
    std::fs::create_dir_all(fixture.root.join("taken")).unwrap();
    assert_refused_unchanged(
        &fixture,
        fixture.options("taken"),
        &mut NoHooks,
        BACKUP_DIR_EXISTS,
    );
}

#[test]
fn a_split_pair_refuses() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .context()
        .execute(
            "UPDATE single_store_state SET state = 'migrated', migrated_at = 1",
            [],
        )
        .unwrap();
    assert_refused_unchanged(&fixture, fixture.options("b"), &mut NoHooks, STATE_SPLIT);
}

#[test]
fn the_command_line_takes_the_documented_flags() {
    let args: Vec<String> = [
        "--context-db",
        "/c.db",
        "--store-db",
        "/s.db",
        "--backup-dir",
        "/b",
        "--dry-run",
        "--skip-foreign",
        "--prefer",
        "git:a=b=context",
        "--accept-id-change",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    let options = parse_args(&args).unwrap();
    assert!(options.dry_run && options.skip_foreign && options.accept_id_change);
    assert_eq!(options.backup_dir, Path::new("/b"));
    assert_eq!(options.prefer.get("git:a=b"), Some(&Winner::Context));
    assert!(parse_args(&["--backup-root".to_string(), "/b".to_string()]).is_err());
}

// ── 5.5: the render comparator ─────────────────────────────────────────────

const HISTORY: &str = "<session-history>\n## 2026-01-01 first\nbody\n</session-history>";

fn render(history: &str, memories: &str) -> String {
    format!("{history}\n\n<project-memory>\n{memories}\n</project-memory>")
}

#[test]
fn renders_differing_only_in_ids_and_in_category_order_compare_equal() {
    let before = render(HISTORY, "<CONSTRAINTS>\n#3: alpha\n#4: beta\n  second line\n</CONSTRAINTS>\n<NOTES>\n-: gamma\n</NOTES>");
    let after = render(HISTORY, "<CONSTRAINTS>\n#11: beta\n  second line\n#12: alpha\n</CONSTRAINTS>\n<NOTES>\n#40: gamma\n</NOTES>");
    assert_eq!(compare_renders(&before, &after), Ok(()));
}

#[test]
fn renders_differing_in_one_memorys_content_fail() {
    let before = render(
        HISTORY,
        "<CONSTRAINTS>\n#3: alpha\n#4: beta\n</CONSTRAINTS>",
    );
    let after = render(
        HISTORY,
        "<CONSTRAINTS>\n#3: alpha\n#4: betA\n</CONSTRAINTS>",
    );
    let error = compare_renders(&before, &after).unwrap_err();
    assert!(error.contains("beta"), "{error}");
}

#[test]
fn renders_differing_in_one_compartment_date_segment_fail() {
    let before = render(HISTORY, "");
    let after = render(&HISTORY.replace("2026-01-01", "2026-01-02"), "");
    let error = compare_renders(&before, &after).unwrap_err();
    assert!(error.contains("2026-01-01"), "{error}");
}

#[test]
fn an_unknown_column_is_named_with_the_statement_that_drops_it() {
    // An old development build added `memories.content_version`; no release knows it.
    let fixture = Fixture::new(Extras::default());
    fixture
        .context()
        .execute_batch("ALTER TABLE memories ADD COLUMN content_version INTEGER;")
        .unwrap();
    let refusal = assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        FINGERPRINT_MISMATCH,
    );
    let message = refusal.to_value().to_string();
    assert!(message.contains("content_version"), "{message}");
    assert!(
        message.contains("ALTER TABLE memories DROP COLUMN content_version;"),
        "{message}"
    );
}

#[test]
fn migration_splits_module_boundaries_and_normalizes_existing_context_rows() {
    let fixture = Fixture::new(Extras::default());
    fixture.store().execute("UPDATE mc_compartments SET start_message_id='m1#0', end_message_id='m5#2' WHERE session_id=?1 AND sequence=1", params![SESSION]).unwrap();
    fixture.context().execute_batch("UPDATE compartments SET start_message_id='m1#0', end_message_id='m5#2' WHERE id=101;
        INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at)
        VALUES ('context-only-flat', 1, 1, 2, 'raw-a#1', 'raw-b#3', 'kept', 'kept body', 1);").unwrap();
    let report = fixture.migrate();
    assert_eq!(report.normalized_context_compartments, 2);
    assert!(report.render_check.passed > 0);
    let context = fixture.context();
    let row: (String, String, Option<i64>, Option<i64>) = context.query_row("SELECT start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE id=101", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
    assert_eq!(row, ("m1".into(), "m5".into(), Some(0), Some(2)));
    let row: (String, String, Option<i64>, Option<i64>) = context.query_row("SELECT start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id='context-only-flat'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap();
    assert_eq!(row, ("raw-a".into(), "raw-b".into(), Some(1), Some(3)));
    let mutations: i64 = context.query_row("SELECT COUNT(*) FROM m0_mutation_log WHERE session_id='context-only-flat' AND mutation_type='compartment_upgrade'", [], |row| row.get(0)).unwrap();
    assert_eq!(mutations, 1);
}

// ── Which copy of a session's history is kept ──────────────────────────────

/// One compartment as a test writes it: sequence, first and last message ordinal, title,
/// and creation time. The content is derived from the title.
type Hist = (i64, i64, i64, &'static str, i64);

const HISTORY_SESSION: &str = "ses_history";

/// Give `HISTORY_SESSION` (attributed to `project`) the given compartments in each file,
/// plus one store event and one context event on sequence 0.
fn seed_history(fixture: &Fixture, project: &str, store_rows: &[Hist], context_rows: &[Hist]) {
    let store = fixture.store();
    let context = fixture.context();
    context
        .execute(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at)
             VALUES (?1, 'opencode', ?2, 1)",
            params![HISTORY_SESSION, project],
        )
        .unwrap();
    for (sequence, start, end, title, created) in store_rows {
        store
            .execute(
                "INSERT INTO mc_compartments(session_id, sequence, start_message, end_message,
                     start_message_id, end_message_id, title, content, p1, importance, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, 50, ?9)",
                params![
                    HISTORY_SESSION,
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
    for (sequence, start, end, title, created) in context_rows {
        context
            .execute(
                "INSERT INTO compartments(id, session_id, sequence, start_message, end_message,
                     start_message_id, end_message_id, title, content, p1, importance, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, 50, ?10)",
                params![
                    500 + sequence,
                    HISTORY_SESSION,
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
    store
        .execute(
            "INSERT INTO mc_compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES (?1, 0, 'store-event', '{}', 1)",
            params![HISTORY_SESSION],
        )
        .unwrap();
    context
        .execute(
            "INSERT INTO compartment_events(session_id, compartment_id, kind, fields_json, created_at)
             VALUES (?1, 500, 'context-event', '{}', 1)",
            params![HISTORY_SESSION],
        )
        .unwrap();
}

/// `(id, sequence, last message ordinal, title)` of every `HISTORY_SESSION` compartment.
fn history_rows(fixture: &Fixture) -> Vec<(i64, i64, i64, String)> {
    fixture
        .context()
        .prepare(
            "SELECT id, sequence, end_message, title FROM compartments
              WHERE session_id = ?1 ORDER BY sequence",
        )
        .unwrap()
        .query_map(params![HISTORY_SESSION], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn history_decision(report: &Report) -> Option<&HistoryDecision> {
    report
        .history
        .iter()
        .find(|decision| decision.session == HISTORY_SESSION)
}

fn event_kinds(fixture: &Fixture) -> Vec<String> {
    fixture
        .context()
        .prepare("SELECT kind FROM compartment_events WHERE session_id = ?1 ORDER BY kind")
        .unwrap()
        .query_map(params![HISTORY_SESSION], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// The shape that lost history in production: a project went back to TypeScript after
/// running in Rust mode. `store.db` stopped at sequence 2; TypeScript then rewrote
/// sequence 2 and kept summarising, so `context.db` is ahead in both content and reach.
#[test]
fn a_typescript_session_that_rewrote_and_extended_history_keeps_its_context_copy() {
    let fixture = Fixture::new(Extras::default());
    seed_history(
        &fixture,
        CONTEXT_PROJECT,
        &[
            (0, 1, 10, "zero", 100),
            (1, 11, 20, "one", 100),
            (2, 21, 22, "two as the module wrote it", 100),
        ],
        &[
            (0, 1, 10, "zero", 100),
            (1, 11, 20, "one", 100),
            (2, 21, 40, "two as typescript rewrote it", 200),
            (3, 41, 60, "three", 300),
            (4, 61, 80, "four", 400),
        ],
    );
    let report = fixture.migrate();
    assert_eq!(
        history_rows(&fixture),
        vec![
            (500, 0, 10, "zero".to_string()),
            (501, 1, 20, "one".to_string()),
            (502, 2, 40, "two as typescript rewrote it".to_string()),
            (503, 3, 60, "three".to_string()),
            (504, 4, 80, "four".to_string()),
        ],
        "every context compartment stays, unchanged and with its id"
    );
    let decision = history_decision(&report).expect("a decision is reported");
    assert_eq!(decision.kept, Winner::Context);
    assert_eq!(decision.reason, HistoryReason::WroteLast);
    assert_eq!(
        event_kinds(&fixture),
        vec!["context-event", "store-event"],
        "the store event on an unchanged compartment is added beside the context's"
    );
    let project = report
        .projects
        .iter()
        .find(|entry| entry.project == CONTEXT_PROJECT)
        .unwrap();
    assert_eq!(project.tables["compartments"].superseded, 1);
    assert_eq!(project.tables["compartments"].deleted, 0);
}

/// A `context.db` copy holding every store compartment and more is kept even when the
/// project is module-owned: nothing the store has is lost by keeping it.
#[test]
fn a_session_whose_context_copy_is_a_superset_keeps_it_whatever_the_owner() {
    let fixture = Fixture::new(Extras::default());
    seed_history(
        &fixture,
        STORE_PROJECT,
        &[(0, 1, 10, "zero", 100)],
        &[(0, 1, 10, "zero", 100), (1, 11, 20, "one", 200)],
    );
    let report = fixture.migrate();
    assert_eq!(history_rows(&fixture).len(), 2);
    let decision = history_decision(&report).unwrap();
    assert_eq!(
        (decision.kept, decision.reason),
        (Winner::Context, HistoryReason::Superset)
    );
}

/// A stalled mirror: the module kept writing `store.db` and `context.db` fell behind. The
/// store's copy is taken and the missing compartments arrive in `context.db`.
#[test]
fn a_session_whose_store_copy_is_ahead_takes_it() {
    let fixture = Fixture::new(Extras::default());
    seed_history(
        &fixture,
        STORE_PROJECT,
        &[
            (0, 1, 10, "zero", 100),
            (1, 11, 20, "one", 200),
            (2, 21, 30, "two", 300),
        ],
        &[(0, 1, 10, "zero", 100)],
    );
    let report = fixture.migrate();
    let rows = history_rows(&fixture);
    assert_eq!(
        rows.iter()
            .map(|(_, sequence, end, _)| (*sequence, *end))
            .collect::<Vec<_>>(),
        vec![(0, 10), (1, 20), (2, 30)]
    );
    assert_eq!(
        rows[0].0, 500,
        "the shared compartment keeps its context id"
    );
    let decision = history_decision(&report).unwrap();
    assert_eq!(
        (decision.kept, decision.reason),
        (Winner::Store, HistoryReason::Superset)
    );
}

#[test]
fn identical_history_is_left_as_it_is_and_not_reported() {
    let fixture = Fixture::new(Extras::default());
    let rows = [(0, 1, 10, "zero", 100), (1, 11, 20, "one", 200)];
    seed_history(&fixture, CONTEXT_PROJECT, &rows, &rows);
    let report = fixture.migrate();
    assert_eq!(
        history_rows(&fixture),
        vec![
            (500, 0, 10, "zero".to_string()),
            (501, 1, 20, "one".to_string())
        ]
    );
    assert!(history_decision(&report).is_none());
}

/// Both copies changed compartments the other lacks, and the evidence disagrees: the
/// project is TypeScript-owned but the store's changes are the newer ones. The run is
/// refused rather than dropping either copy, and the operator's choice then moves it.
#[test]
fn diverged_history_refuses_until_a_copy_is_preferred() {
    let fixture = Fixture::new(Extras::default());
    seed_history(
        &fixture,
        CONTEXT_PROJECT,
        &[
            (0, 1, 10, "zero", 100),
            (1, 11, 30, "one by the module", 300),
        ],
        &[
            (0, 1, 10, "zero", 100),
            (1, 11, 20, "one by typescript", 200),
            (2, 21, 25, "two by typescript", 200),
        ],
    );
    let refusal = assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut NoHooks,
        HISTORY_DIVERGED,
    );
    let detail = refusal.to_value().to_string();
    assert!(
        detail.contains(&format!("--prefer-history {HISTORY_SESSION}=context")),
        "{detail}"
    );
    let mut options = fixture.options("b2");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Context);
    let report = run(&options, &mut NoHooks).unwrap();
    assert_eq!(history_rows(&fixture).len(), 3);
    assert_eq!(
        history_decision(&report).unwrap().reason,
        HistoryReason::Preferred
    );
}

/// The shared fixture's session is module-owned and both copies carry the same
/// timestamps (the mirror copied them), so the owner decides and the store's rewrite wins.
#[test]
fn equal_timestamps_fall_back_to_the_project_owner() {
    let fixture = Fixture::new(Extras::default());
    let report = fixture.migrate();
    let decision = report
        .history
        .iter()
        .find(|decision| decision.session == SESSION)
        .unwrap();
    assert_eq!(
        (decision.kept, decision.reason),
        (Winner::Store, HistoryReason::ProjectOwner)
    );
}

#[test]
fn the_command_line_takes_prefer_history() {
    let args: Vec<String> = [
        "--context-db",
        "c",
        "--store-db",
        "s",
        "--backup-dir",
        "b",
        "--prefer-history",
        "ses_a=context",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    let options = parse_args(&args).unwrap();
    assert_eq!(options.prefer_history.get("ses_a"), Some(&Winner::Context));
    let mut bad = args.clone();
    bad[7] = "ses_a=both".into();
    assert!(parse_args(&bad).is_err());
}

fn seed_workspace(fixture: &Fixture, stale: bool, seeded_labels: bool) {
    for (conn, prefix) in [(fixture.store(), "mc_"), (fixture.context(), "")] {
        conn.execute(&format!("INSERT INTO {prefix}workspaces(id, name, created_at, updated_at) VALUES (1, 'shared', 1, 1)"), []).unwrap();
        for (project, name) in [(STORE_PROJECT, "rust"), ("git:typescript", "typescript")] {
            let label = if prefix == "mc_" && seeded_labels {
                project
            } else {
                name
            };
            conn.execute(&format!("INSERT INTO {prefix}workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (1, ?1, ?2, '', 1)"), params![project, label]).unwrap();
        }
        let content = if prefix == "mc_" && stale {
            "stale foreign"
        } else {
            "current foreign"
        };
        conn.execute(&format!("INSERT INTO {prefix}memories(id, project_path, category, content, normalized_hash, shareable, scope, created_at, updated_at, first_seen_at, last_seen_at) VALUES (50, 'git:typescript', 'CONSTRAINTS', ?1, 'foreign', 1, 'project', 1000, 1000, 1000, 1000)"), params![content]).unwrap();
    }
}

#[test]
fn issue682_stale_foreign_workspace_memories_use_context_on_both_sides() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, true, false);
    let report = fixture.migrate();
    assert_eq!(report.render_check.passed, 1);
    assert_eq!(memory_content(&fixture.context(), 50), "current foreign");
}

#[test]
fn issue682_workspace_labels_are_copied_from_context() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, false, true);
    assert_eq!(
        run(&fixture.options("b"), &mut CheckWorkspaceLabels)
            .unwrap()
            .render_check
            .passed,
        1
    );
}

#[test]
fn issue682_deleted_provenance_is_reported_and_existing_ids_are_preserved() {
    let fixture = Fixture::new(Extras::default());
    fixture.store().execute_batch("UPDATE mc_memories SET merged_from = '[1,777]', superseded_by_memory_id = 778 WHERE id = 5;
        UPDATE mc_memories SET merged_from = '[1,779]' WHERE id = 2;").unwrap();
    fixture
        .context()
        .execute_batch(
            "UPDATE context_privilege_state SET enabled = 1;
        UPDATE memories SET merged_from = '[1,779]' WHERE id = 6;
        UPDATE context_privilege_state SET enabled = 0;",
        )
        .unwrap();
    let report = fixture.migrate();
    let context = fixture.context();
    let five = context_id_of(&context, "store five");
    let (merged, superseded): (String, Option<i64>) = context
        .query_row(
            "SELECT merged_from, superseded_by_memory_id FROM memories WHERE id = ?1",
            params![five],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(merged, "[5]");
    assert_eq!(superseded, None);
    let seeded: String = context
        .query_row("SELECT merged_from FROM memories WHERE id = 6", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        seeded, "[1]",
        "the seeded twin's ids are context ids, not store ids"
    );
    let value = report.to_value();
    assert_eq!(value["dropped_provenance_count"], 3);
    let dropped = value["dropped_provenance"].as_array().unwrap();
    for (memory, reference, field, space) in [
        (5, 777, "merged_from", "store"),
        (5, 778, "superseded_by_memory_id", "store"),
        (6, 779, "merged_from", "context"),
    ] {
        assert!(
            dropped.iter().any(|entry| entry["memory_id"] == memory
                && entry["dropped_reference"] == reference
                && entry["field"] == field
                && entry["id_space"] == space),
            "{value}"
        );
    }
}

fn seed_mid_session(fixture: &Fixture) {
    let rows: Vec<Hist> = (0..=324)
        .map(|seq| (seq, seq * 10, seq * 10 + 9, "history", 1000))
        .collect();
    seed_history(fixture, STORE_PROJECT, &rows[250..], &rows[..302]);
    fixture.context().execute("UPDATE compartments SET start_message_id = start_message_id || '#0', end_message_id = end_message_id || '#0' WHERE session_id = ?1", params![HISTORY_SESSION]).unwrap();
}

#[test]
fn issue682_store_history_keeps_a_contiguous_context_prefix() {
    let fixture = Fixture::new(Extras::default());
    seed_mid_session(&fixture);
    let mut options = fixture.options("b");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Store);
    run(&options, &mut NoHooks).unwrap();
    assert_eq!(
        history_rows(&fixture)
            .iter()
            .map(|row| row.1)
            .collect::<Vec<_>>(),
        (0..=324).collect::<Vec<_>>()
    );
    assert_eq!(event_kinds(&fixture), vec!["context-event", "store-event"]);
}

#[test]
fn issue682_own_memory_is_not_deduplicated_by_foreign_content_or_hash() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, false, false);
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET content = 'store two', normalized_hash = 'h-s2' WHERE id = 50",
            [],
        )
        .unwrap();
    fixture
        .context()
        .execute(
            "UPDATE memories SET content = 'store two', normalized_hash = 'h-s2' WHERE id = 50",
            [],
        )
        .unwrap();
    assert_eq!(fixture.migrate().render_check.passed, 1);
    let count: i64 = fixture
        .context()
        .query_row(
            "SELECT COUNT(*) FROM memories WHERE content = 'store two'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn issue682_existing_provenance_does_not_hide_an_active_own_memory() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, false, false);
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET merged_from = '[1]', superseded_by_memory_id = 1 WHERE id = 5",
            [],
        )
        .unwrap();
    assert_eq!(fixture.migrate().render_check.passed, 1);
}

#[test]
fn issue682_own_visibility_does_not_require_workspace_sharing() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, false, false);
    fixture.store().execute("UPDATE mc_memories SET shareable = 0, scope = 'session', category = 'ARCHITECTURE' WHERE id = 2", []).unwrap();
    assert_eq!(fixture.migrate().render_check.passed, 1);
}

#[test]
fn issue682_foreign_context_id_can_equal_an_own_store_id() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, false, false);
    fixture
        .context()
        .execute("UPDATE memories SET id = 2 WHERE id = 50", [])
        .unwrap();
    assert_eq!(fixture.migrate().render_check.passed, 1);
    assert_eq!(memory_content(&fixture.context(), 2), "current foreign");
    assert_eq!(memory_content(&fixture.context(), 6), "store two");
}

#[test]
fn issue682_id_only_remap_including_zero_and_order_preserves_every_own_render_line() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .context()
        .execute_batch(
            "UPDATE context_privilege_state SET enabled = 1;
        UPDATE memories SET id = 0 WHERE id = 7;
        UPDATE context_privilege_state SET enabled = 0;",
        )
        .unwrap();
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET content = 'line one\nline two\n' WHERE id = 3",
            [],
        )
        .unwrap();
    assert_eq!(fixture.migrate().render_check.passed, 1);
    assert_eq!(
        memory_content(&fixture.context(), 0),
        "line one\nline two\n"
    );
    let own = composed_own_lines(&fixture, STORE_PROJECT);
    assert_eq!(own.len(), 4);
    assert_eq!(
        own.get("project-memory/CONSTRAINTS|#: line one\n  line two\n  "),
        Some(&1)
    );
}

struct CheckWorkspaceLabels;
impl EngineHooks for CheckWorkspaceLabels {
    fn after_copy(&mut self, conn: &Connection) -> Result<(), EngineError> {
        let name: String = conn.query_row("SELECT display_name FROM main.mc_workspace_members WHERE project_path = 'git:typescript'", [], |row| row.get(0))?;
        assert_eq!(
            name, "typescript",
            "repair the label data, not the render comparison"
        );
        Ok(())
    }
}

struct CorruptOwnMemory;
impl EngineHooks for CorruptOwnMemory {
    fn after_copy(&mut self, conn: &Connection) -> Result<(), EngineError> {
        conn.execute_batch(
            "UPDATE ctx.context_privilege_state SET enabled = 1;
            UPDATE ctx.memories SET content = 'corrupted own memory' WHERE id = 6;
            UPDATE ctx.context_privilege_state SET enabled = 0;",
        )?;
        Ok(())
    }
}

#[test]
fn issue682_corrupted_own_memory_still_refuses_with_stale_foreign_members() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, true, true);
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut CorruptOwnMemory,
        VERIFY_MISMATCH,
    );
}

struct CorruptOwnBaseline;
impl EngineHooks for CorruptOwnBaseline {
    fn after_copy(&mut self, conn: &Connection) -> Result<(), EngineError> {
        conn.execute(
            "UPDATE main.mc_memories SET content = 'wrong own baseline' WHERE id = 2",
            [],
        )?;
        Ok(())
    }
}

#[test]
fn issue682_own_memory_render_comparison_remains_strict() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, true, true);
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut CorruptOwnBaseline,
        RENDER_MISMATCH,
    );
}

struct CorruptIdRemap;
impl EngineHooks for CorruptIdRemap {
    fn after_copy(&mut self, conn: &Connection) -> Result<(), EngineError> {
        conn.execute_batch(
            "UPDATE ctx.context_privilege_state SET enabled = 1;
            UPDATE ctx.memories SET merged_from = '[1]' WHERE content = 'store four';
            UPDATE ctx.context_privilege_state SET enabled = 0;",
        )?;
        Ok(())
    }
}

#[test]
fn issue682_wrong_remap_to_an_existing_id_still_refuses() {
    let fixture = Fixture::new(Extras::default());
    assert_refused_unchanged(
        &fixture,
        fixture.options("b"),
        &mut CorruptIdRemap,
        VERIFY_MISMATCH,
    );
}

#[test]
fn issue682_real_overlap_content_difference_still_refuses() {
    let fixture = Fixture::new(Extras::default());
    seed_mid_session(&fixture);
    fixture.context().execute("UPDATE compartments SET content = 'a real rewrite' WHERE session_id = ?1 AND sequence = 250", params![HISTORY_SESSION]).unwrap();
    let mut options = fixture.options("b");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Store);
    assert_refused_unchanged(&fixture, options, &mut NoHooks, HISTORY_DIVERGED);
}

#[test]
fn issue682_nonzero_boundary_difference_still_refuses() {
    let fixture = Fixture::new(Extras::default());
    seed_mid_session(&fixture);
    fixture.context().execute("UPDATE compartments SET start_message_id = 'm2500#7' WHERE session_id = ?1 AND sequence = 250", params![HISTORY_SESSION]).unwrap();
    let mut options = fixture.options("b");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Store);
    assert_refused_unchanged(&fixture, options, &mut NoHooks, HISTORY_DIVERGED);
}

#[test]
fn issue682_overlap_requires_both_named_block_index_columns() {
    for name in ["start_block_index", "end_block_index"] {
        assert!(
            COMPARTMENT_COLUMNS.contains(&name),
            "COMPARTMENT_COLUMNS must include {name}"
        );
    }
}

#[test]
fn issue682_a_gap_in_the_joined_history_still_refuses() {
    let fixture = Fixture::new(Extras::default());
    seed_mid_session(&fixture);
    fixture
        .context()
        .execute(
            "DELETE FROM compartments WHERE session_id = ?1 AND sequence = 249",
            params![HISTORY_SESSION],
        )
        .unwrap();
    let mut options = fixture.options("b");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Store);
    assert_refused_unchanged(&fixture, options, &mut NoHooks, HISTORY_DIVERGED);
}

#[test]
fn issue682_context_winning_dangling_provenance_is_also_reported() {
    let fixture = Fixture::new(Extras::default());
    fixture.context().execute("UPDATE memories SET merged_from = '[777,6]', superseded_by_memory_id = 778 WHERE id = 1", []).unwrap();
    let report = fixture.migrate();
    assert_eq!(report.dropped_provenance_count, 2);
    assert!(report
        .dropped_provenance
        .iter()
        .all(|entry| entry.id_space == Winner::Context && entry.memory_id == 1));
    let refs: (String, Option<i64>) = fixture
        .context()
        .query_row(
            "SELECT merged_from, superseded_by_memory_id FROM memories WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(refs, ("[6]".into(), None));
}

#[test]
fn issue682_newly_allocated_id_does_not_resurrect_deleted_provenance() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .store()
        .execute(
            "UPDATE mc_memories SET merged_from = '[9]' WHERE id = 5",
            [],
        )
        .unwrap();
    let report = fixture.migrate();
    assert_eq!(report.dropped_provenance_count, 1);
    assert_eq!(report.dropped_provenance[0].dropped_reference, 9);
    assert_eq!(
        memory_content(&fixture.context(), 9),
        "store seven",
        "the new row is unrelated to the deleted source"
    );
    let refs: String = fixture
        .context()
        .query_row(
            "SELECT merged_from FROM memories WHERE content = 'store five'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(refs, "[]");
}

#[test]
fn issue682_context_reference_with_a_seeded_store_counterpart_is_remapped_not_dropped() {
    let fixture = Fixture::new(Extras::default());
    fixture
        .context()
        .execute("UPDATE memories SET merged_from = '[99]' WHERE id = 1", [])
        .unwrap();
    fixture.store().execute("INSERT INTO mc_memories(id, project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, context_store_uuid, context_row_id) VALUES (8, ?1, 'CONSTRAINTS', 'source retained only in store', 'retained-source', 1, 1, 1, 1, ?2, 99)", params![STORE_PROJECT, FILE_UUID]).unwrap();
    let report = fixture.migrate();
    assert_eq!(report.dropped_provenance_count, 0);
    let id = context_id_of(&fixture.context(), "source retained only in store");
    let refs: String = fixture
        .context()
        .query_row("SELECT merged_from FROM memories WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(refs, format!("[{id}]"));
}

fn logical_query(conn: &Connection, sql: &str, project: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).unwrap();
    let width = stmt.column_count();
    let mut rows: Vec<_> = stmt
        .query_map(params![project], |row| {
            let values = (0..width)
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(row_key(&values))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows.sort();
    rows
}

fn composed_own_lines(fixture: &Fixture, project: &str) -> BTreeMap<String, usize> {
    let conn = fixture.store();
    conn.execute(
        "ATTACH DATABASE ?1 AS ctx",
        params![fixture.context_db.to_str().unwrap()],
    )
    .unwrap();
    let inputs = M0ComposeInputs {
        session_id: SESSION,
        project_path: project,
        project_directory: "",
        now_ms: NOW,
        history_budget_tokens: 1e12,
        covered_system_messages: &[],
        memory_enabled: true,
        memory_budget_tokens: 1e15,
        score_selector: mc_store::ScoreSelector::Base,
        user_profile_budget_tokens: 0.0,
        inject_docs: false,
        temporal_awareness: true,
        mural: None,
    };
    let composed =
        compose_m0_from_store(&ContextSource(&conn), &inputs, |text| text.len() / 4).unwrap();
    memory_multiset(&split_history(&composed.m0_bytes).1)
        .into_iter()
        .filter(|(line, _)| line.contains("|#: "))
        .collect()
}

#[test]
fn issue682_combined_dry_run_then_real_run_preserves_two_rust_projects() {
    let fixture = Fixture::new(Extras::default());
    seed_workspace(&fixture, true, true);
    seed_mid_session(&fixture);
    let store = fixture.store();
    let context = fixture.context();
    for domain in ["memories", "notes"] {
        store.execute("INSERT INTO mc_authority(context_store_uuid, project, domain, state) VALUES (?1, ?2, ?3, 'MODULE')", params![FILE_UUID, CONTEXT_PROJECT, domain]).unwrap();
    }
    context.execute("INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?1, ?2, 1)", params![CONTEXT_PROJECT, FILE_UUID]).unwrap();
    context.execute("INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('ses_second_rust', 'opencode', ?1, 1)", params![CONTEXT_PROJECT]).unwrap();
    store.execute("INSERT INTO mc_cache_state(session_id, row_version, core_state, meta, last_activity_at) VALUES ('ses_second_rust', 1, '{}', '{}', ?1)", params![NOW]).unwrap();
    for (conn, prefix) in [(&store, "mc_"), (&context, "")] {
        conn.execute(&format!("INSERT INTO {prefix}workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (1, ?1, 'second rust', '', 1)"), params![CONTEXT_PROJECT]).unwrap();
        for member in 2..=5 {
            let project = format!("git:typescript{member}");
            let name = if prefix == "mc_" {
                project.clone()
            } else {
                format!("typescript{member}")
            };
            conn.execute(&format!("INSERT INTO {prefix}workspace_members(workspace_id, project_path, display_name, display_path, added_at) VALUES (1, ?1, ?2, '', 1)"), params![project, name]).unwrap();
            let content = if prefix == "mc_" { "stale" } else { "fresh" };
            conn.execute(&format!("INSERT INTO {prefix}memories(id, project_path, category, content, normalized_hash, shareable, scope, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?1, ?2, 'CONSTRAINTS', ?3, ?2, 1, 'project', 1000, 1000, 1000, 1000)"), params![50+member, project, format!("{content} member {member}")]).unwrap();
        }
    }
    // Deliberately collide a foreign context id with an own store id. Every reader must
    // keep the two namespaces separate even when all seven workspace members render.
    context
        .execute("UPDATE memories SET id = 2 WHERE id = 50", [])
        .unwrap();
    store.execute_batch("UPDATE mc_memories SET merged_from = '[1,777]' WHERE id = 5;
        UPDATE mc_privilege_state SET note_caller_project = 'git:store-wins';
        UPDATE mc_notes SET status = 'ready';
        UPDATE mc_privilege_state SET note_caller_project = 'git:context-wins';
        INSERT INTO mc_notes(type, project_path, session_id, content, status, created_at_ms, updated_at_ms) VALUES ('session', 'git:context-wins', 'ses_second_rust', 'second rust note', 'ready', 3000, 3000);
        UPDATE mc_privilege_state SET note_caller_project = '';") .unwrap();
    store.execute("INSERT INTO mc_compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, importance, created_at) VALUES ('ses_second_rust', 0, 0, 9, 'second-start', 'second-end', 'second', 'second history', 50, 1000)", []).unwrap();

    let memories_sql = format!(
        "SELECT {} FROM mc_memories WHERE project_path = ?1",
        column_list(MEMORY_COLUMNS)
    );
    let notes_expr: Vec<_> = NOTE_COLUMNS
        .iter()
        .map(|column| match *column {
            "created_at" => "created_at_ms".to_string(),
            "updated_at" => "updated_at_ms".to_string(),
            "harness" => "'opencode'".to_string(),
            other => format!("\"{other}\""),
        })
        .collect();
    let notes_sql = format!(
        "SELECT {} FROM mc_notes WHERE project_path = ?1",
        notes_expr.join(",")
    );
    let compartments_expr: Vec<_> = COMPARTMENT_COLUMNS
        .iter()
        .map(|column| match *column {
            "harness" => "'opencode'".to_string(),
            "rebase_status" => "'ok'".to_string(),
            "start_block_index" | "end_block_index" => "NULL".to_string(),
            other => format!("\"{other}\""),
        })
        .collect();
    let compartments_sql = format!(
        "SELECT {} FROM mc_compartments WHERE session_id = ?1",
        compartments_expr.join(",")
    );
    let expected_memories: Vec<_> = [STORE_PROJECT, CONTEXT_PROJECT]
        .iter()
        .map(|project| logical_query(&store, &memories_sql, project))
        .collect();
    let expected_notes: Vec<_> = [STORE_PROJECT, CONTEXT_PROJECT]
        .iter()
        .map(|project| logical_query(&store, &notes_sql, project))
        .collect();
    let expected_second_history = logical_query(&store, &compartments_sql, "ses_second_rust");
    let expected_tail = logical_query(&store, &compartments_sql, HISTORY_SESSION);
    let prefix_expr: Vec<_> = COMPARTMENT_COLUMNS
        .iter()
        .map(|column| match *column {
            "start_message_id" | "end_message_id" => format!("replace(\"{column}\", '#0', '')"),
            "start_block_index" | "end_block_index" => "0".to_string(),
            other => format!("\"{other}\""),
        })
        .collect();
    let mut expected_joined = logical_query(
        &context,
        &format!(
            "SELECT {} FROM compartments WHERE session_id = ?1 AND sequence < 250",
            prefix_expr.join(",")
        ),
        HISTORY_SESSION,
    );
    expected_joined.extend(expected_tail);
    expected_joined.sort();
    let expected_foreign = logical_query(&context, "SELECT id, project_path, category, content, shareable, scope FROM memories WHERE project_path LIKE 'git:typescript%' AND ?1 != ''", "all");
    drop(context);
    drop(store);
    let before = fixture.digest();
    let mut options = fixture.options("combined-backup");
    options
        .prefer_history
        .insert(HISTORY_SESSION.into(), Winner::Store);
    options.dry_run = true;
    let preview = run(&options, &mut NoHooks).unwrap();
    assert_eq!(
        fixture.digest(),
        before,
        "preview leaves both source files unchanged"
    );
    assert!(!options.backup_dir.exists());
    options.dry_run = false;
    let report = run(&options, &mut NoHooks).unwrap();
    let context = fixture.context();
    let store = fixture.store();
    assert_eq!(preview.render_check, report.render_check);
    assert_eq!(report.render_check.passed, 2);
    assert_eq!(report.dropped_provenance_count, 1);
    assert_eq!(
        history_decision(&report)
            .unwrap()
            .context_prefix_compartments,
        250
    );
    for (index, project) in [STORE_PROJECT, CONTEXT_PROJECT].iter().enumerate() {
        assert_eq!(
            logical_query(
                &context,
                &format!(
                    "SELECT {} FROM memories WHERE project_path = ?1",
                    column_list(MEMORY_COLUMNS)
                ),
                project
            ),
            expected_memories[index]
        );
        assert_eq!(
            logical_query(
                &context,
                &format!(
                    "SELECT {} FROM notes WHERE project_path = ?1",
                    column_list(NOTE_COLUMNS)
                ),
                project
            ),
            expected_notes[index]
        );
        let expected_lines: BTreeMap<_, _> = if *project == STORE_PROJECT {
            ["store one", "store two", "three", "store five"]
                .into_iter()
                .map(|content| (format!("project-memory/CONSTRAINTS|#: {content}"), 1))
                .collect()
        } else {
            ["store variant", "store seven"]
                .into_iter()
                .map(|content| (format!("project-memory/CONSTRAINTS|#: {content}"), 1))
                .collect()
        };
        assert_eq!(
            composed_own_lines(&fixture, project),
            expected_lines,
            "every own row renders, not just equal subsets"
        );
    }
    assert_eq!(
        logical_query(
            &context,
            &format!(
                "SELECT {} FROM compartments WHERE session_id = ?1",
                column_list(COMPARTMENT_COLUMNS)
            ),
            HISTORY_SESSION
        ),
        expected_joined
    );
    assert_eq!(
        logical_query(
            &context,
            &format!(
                "SELECT {} FROM compartments WHERE session_id = ?1",
                column_list(COMPARTMENT_COLUMNS)
            ),
            "ses_second_rust"
        ),
        expected_second_history
    );
    assert_eq!(logical_query(&context, "SELECT id, project_path, category, content, shareable, scope FROM memories WHERE project_path LIKE 'git:typescript%' AND ?1 != ''", "all"), expected_foreign);
    assert_eq!(
        history_rows(&fixture)
            .iter()
            .map(|row| row.1)
            .collect::<Vec<_>>(),
        (0..=324).collect::<Vec<_>>()
    );
    for conn in [&context, &store] {
        let check: String = conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(check, "ok");
    }
}

#[test]
fn independent_first_transform_after_real_migration_rebuilds_complete_old_pair() {
    use crate::transform::{
        tests::{item, memory_input, pctx, req, store},
        transform,
    };
    let fixture = Fixture::new(Extras::default());
    // Start with a complete, already-served pair so missing cache bytes cannot
    // explain the first rebuild after migration.
    let source_dir = tempfile::tempdir().unwrap();
    let source = store(source_dir.path());
    source
        .insert_memory(memory_input(
            STORE_PROJECT,
            "CONSTRAINTS",
            "OLD_RESET_SENTINEL",
            0,
        ))
        .unwrap();
    let request = req(SESSION, "unchanged", vec![item("tail", 100, "tail")]);
    let mut ctx = pctx(STORE_PROJECT, "/nonexistent-docs", NOW);
    ctx.compaction_enabled = false;
    transform(&source, &request, &ctx).unwrap();
    let before = source.load(SESSION).unwrap();
    fixture
        .store()
        .execute(
            "UPDATE mc_cache_state SET core_state=?1,meta=?2 WHERE session_id=?3",
            params![
                serde_json::to_string(&before.core).unwrap(),
                serde_json::to_string(&before.meta).unwrap(),
                SESSION
            ],
        )
        .unwrap();
    fixture.migrate();
    let migrated = store(&fixture.root);
    let reset = migrated.load(SESSION).unwrap();
    assert_eq!(reset.meta.max_memory_id, 0);
    assert!(reset.meta.bootstrap_seed_fold_pending);
    let first = transform(&migrated, &request, &ctx).unwrap();
    assert_eq!(first.action, "HARD", "{:?}", first.materialize_reason);
    assert!(!serde_json::to_string(first.messages())
        .unwrap()
        .contains("OLD_RESET_SENTINEL"));
    assert!(
        !migrated
            .load(SESSION)
            .unwrap()
            .meta
            .bootstrap_seed_fold_pending
    );
    assert_ne!(transform(&migrated, &request, &ctx).unwrap().action, "HARD");
}
