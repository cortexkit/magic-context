use super::*;
use crate::context_db::ContextDb;

const SESSION: &str = "ses_moved";
const HARNESS: &str = "opencode";

/// Seven message rows with one completed compaction pair (rows 4 and 5).
/// The plugin numbers them 1, 2, 3, 4 (the opener), -, 5, 6; the runner's
/// entries are 1, 2, 3, -, -, 4, 5.
fn transcript() -> Vec<HostMessage> {
    let row = |mid: &str, entry: Option<u64>, finished_summary: bool| HostMessage {
        mid: mid.into(),
        entry,
        finished_summary,
        added: false,
        pi: None,
    };
    vec![
        row("u1", Some(1), false),
        row("a2", Some(2), false),
        row("u3", Some(3), false),
        row("opener", None, false),
        row("summary", None, true),
        row("u6", Some(4), false),
        row("a7", Some(5), false),
    ]
}

fn newest() -> Cursor {
    Cursor::new(5, "a7", "d")
}

fn numbering() -> Numbering {
    Numbering::opencode(&transcript(), &newest()).unwrap()
}

struct Store {
    _dir: std::path::PathBuf,
    path: std::path::PathBuf,
}

impl Store {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "mc-renumber-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("context.db");
        ContextDb::create_for_tests(&path).unwrap();
        Self { _dir: dir, path }
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.path).unwrap()
    }

    fn summary(&self, sequence: i64, (start, start_id): (i64, &str), (end, end_id): (i64, &str)) {
        self.conn()
            .execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                     start_message_id, end_message_id, title, content, p1, created_at, harness)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 't', 'c', 'c', 1, ?7)",
                params![SESSION, sequence, start, end, start_id, end_id, HARNESS],
            )
            .unwrap();
    }

    fn query<T: rusqlite::types::FromSql>(&self, sql: &str) -> Vec<T> {
        let conn = self.conn();
        let mut statement = conn.prepare(sql).unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}

/// Everything the plugin stored for the session, numbered its way.
fn seed(store: &Store) {
    store.summary(0, (1, "u1"), (4, "opener"));
    store.summary(1, (5, "u6"), (6, "a7"));
    let conn = store.conn();
    conn.execute_batch(&format!(
        "INSERT INTO memory_publications (publication_id, project_path, source_session_id)
             VALUES ('p1', '/p', '{SESSION}'), ('p2', '/p', 'ses_other');
         INSERT INTO memory_fact_blocks (publication_id, source_session_id, start_ordinal, end_ordinal, role, parts_json, joined_text)
             VALUES ('p1', '{SESSION}', 3, 5, 'user', '[]', 'x'), ('p2', 'ses_other', 3, 5, 'user', '[]', 'x');
         INSERT INTO notes (type, content, session_id, created_at, updated_at, harness, anchor_ordinal)
             VALUES ('session', 'late', '{SESSION}', 1, 1, '{HARNESS}', 6), ('session', 'at the opener', '{SESSION}', 1, 1, '{HARNESS}', 4);
         INSERT INTO user_memory_candidates (content, session_id, source_compartment_start, source_compartment_end, created_at)
             VALUES ('likes tests', '{SESSION}', 5, 6, 1);
         INSERT INTO user_memories (content, promoted_at, source_candidate_provenance, created_at, updated_at)
             VALUES ('likes tests', 1, '[{{\"candidate_id\":1,\"session_id\":\"{SESSION}\",\"source_compartment_start\":5,\"source_compartment_end\":6}},{{\"candidate_id\":2,\"session_id\":\"ses_other\",\"source_compartment_start\":5,\"source_compartment_end\":6}}]', 1, 1);
         INSERT INTO primer_candidates (project_path, harness, session_id, question, normalized_question, source_compartment_start, source_compartment_end, source_start_message_id, source_end_message_id, source_message_time, created_at)
             VALUES ('/p', '{HARNESS}', '{SESSION}', 'q', 'q', 2, 5, 'a2', 'u6', 1, 1);
         INSERT INTO compression_depth (session_id, message_ordinal, depth, harness)
             VALUES ('{SESSION}', 4, 1, '{HARNESS}'), ('{SESSION}', 5, 2, '{HARNESS}');
         INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
             VALUES ('{SESSION}', 6, 4, 1, '{HARNESS}');
         INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
             VALUES ('{SESSION}', 'u3', 3, 'v', 'h', 'user', '{HARNESS}', 1),
                    ('{SESSION}', 'opener', 4, 'v', 'h', 'user', '{HARNESS}', 1),
                    ('{SESSION}', 'a7', 6, 'v', 'h', 'assistant', '{HARNESS}', 1),
                    ('{SESSION}', 'reverted', 9, 'v', 'h', 'user', '{HARNESS}', 1);
         INSERT INTO message_history_fts (rowid, session_id, message_ordinal, message_id, role, content)
             VALUES (10, '{SESSION}', 3, 'u3', 'user', 'parser'),
                    (11, '{SESSION}', 4, 'opener', 'user', 'what next'),
                    (12, '{SESSION}', 6, 'a7', 'assistant', 'fixed the crash'),
                    (13, '{SESSION}', 9, 'reverted', 'user', 'gone');
         INSERT INTO message_fts_rowid_map (session_id, message_ordinal, fts_rowid, message_time_ms)
             VALUES ('{SESSION}', 3, 10, 30), ('{SESSION}', 4, 11, 40), ('{SESSION}', 6, 12, 60), ('{SESSION}', 9, 13, 90);
         INSERT INTO schema_migrations_meta (key, value)
             VALUES ('message_index_skip:[\"{SESSION}\",\"a7\"]', '{{\"ordinal\":6}}'),
                    ('message_index_skip:[\"{SESSION}\",\"opener\"]', '{{\"ordinal\":4}}');"
    ))
    .unwrap();
}

fn run(store: &Store, numbering: &Numbering) -> Result<(), String> {
    renumber(&mut store.conn(), HARNESS, SESSION, numbering)
}

#[test]
fn every_stored_number_moves_to_the_runners_numbering() {
    let store = Store::new("all");
    seed(&store);
    run(&store, &numbering()).unwrap();

    // The first summary covered the opener too; it ends at the last entry
    // before it.
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-3", "4-5"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT source_session_id || ':' || start_ordinal || '-' || end_ordinal
             FROM memory_fact_blocks ORDER BY id"
        ),
        [format!("{SESSION}:3-4"), "ses_other:3-5".into()]
    );
    // Note anchors are positions: the opener's maps to the entry before it.
    assert_eq!(
        store.query::<i64>("SELECT anchor_ordinal FROM notes ORDER BY id"),
        [5, 3]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT source_compartment_start || '-' || source_compartment_end FROM user_memory_candidates"
        ),
        ["4-5"]
    );
    let provenance: Value = serde_json::from_str(
        &store.query::<String>("SELECT source_candidate_provenance FROM user_memories")[0],
    )
    .unwrap();
    assert_eq!(provenance[0]["source_compartment_start"], 4);
    assert_eq!(provenance[0]["source_compartment_end"], 5);
    assert_eq!(
        provenance[1]["source_compartment_start"], 5,
        "another session's"
    );
    assert_eq!(
        store.query::<String>(
            "SELECT source_compartment_start || '-' || source_compartment_end FROM primer_candidates"
        ),
        ["2-4"]
    );
    // The opener's depth row goes; the next message's moves down.
    assert_eq!(
        store.query::<String>(
            "SELECT message_ordinal || ':' || depth FROM compression_depth ORDER BY message_ordinal"
        ),
        ["4:2"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT last_indexed_ordinal || '/' || dirty_floor_ordinal FROM message_history_index"
        ),
        ["5/3"]
    );
    // Search rows follow their message; the opener's and the reverted
    // message's go.
    assert_eq!(
        store.query::<String>(
            "SELECT message_id || ':' || message_ordinal FROM message_history_source ORDER BY message_ordinal"
        ),
        ["u3:3", "a7:5"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT rowid || ':' || message_ordinal FROM message_history_fts ORDER BY rowid"
        ),
        ["10:3", "12:5"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT message_ordinal || ':' || fts_rowid || ':' || message_time_ms
             FROM message_fts_rowid_map ORDER BY message_ordinal"
        ),
        ["3:10:30", "5:12:60"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT key || '=' || value FROM schema_migrations_meta WHERE key LIKE 'message_index_skip:%'"
        ),
        [format!("message_index_skip:[\"{SESSION}\",\"a7\"]={{\"ordinal\":5}}")]
    );
    // Search still finds the moved rows by their text.
    assert_eq!(
        store.query::<i64>(
            "SELECT message_ordinal FROM message_history_fts WHERE message_history_fts MATCH 'crash'"
        ),
        [5]
    );
}

#[test]
fn a_retried_move_does_not_shift_the_numbers_twice() {
    let store = Store::new("retry");
    seed(&store);
    run(&store, &numbering()).unwrap();
    run(&store, &numbering()).unwrap();
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-3", "4-5"]
    );
    // A different transcript can't convert them again.
    let mut other = transcript();
    other.insert(
        0,
        HostMessage {
            mid: "u0".into(),
            entry: None,
            finished_summary: false,
            added: false,
            pi: None,
        },
    );
    let refused = run(&store, &Numbering::opencode(&other, &newest()).unwrap()).unwrap_err();
    assert!(refused.starts_with("renumber_conflict:"), "{refused}");
}

#[test]
fn a_summary_naming_other_messages_refuses_and_changes_nothing() {
    let store = Store::new("mismatch");
    seed(&store);
    store
        .conn()
        .execute(
            "UPDATE compartments SET end_message_id = 'u6' WHERE sequence = 0",
            [],
        )
        .unwrap();
    let refused = run(&store, &numbering()).unwrap_err();
    assert!(refused.starts_with("ordinal_mismatch:"), "{refused}");
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-4", "5-6"]
    );
    assert_eq!(
        store.query::<i64>("SELECT anchor_ordinal FROM notes ORDER BY id"),
        [6, 4]
    );
    assert!(store
        .query::<String>("SELECT key FROM schema_migrations_meta WHERE key LIKE 'mode3_renumber:%'")
        .is_empty());
}

#[test]
fn a_range_covering_only_marker_rows_refuses() {
    let store = Store::new("unmapped");
    store.summary(0, (4, "opener"), (4, "opener"));
    let refused = run(&store, &numbering()).unwrap_err();
    assert!(refused.starts_with("ordinal_unmapped:"), "{refused}");
}

#[test]
fn the_message_list_must_end_at_the_newest_message_with_rising_entries() {
    let mut short = transcript();
    short.pop();
    let refused = Numbering::opencode(&short, &newest()).unwrap_err();
    assert!(refused.starts_with("invalid_messages:"), "{refused}");
    let mut falling = transcript();
    falling[2].entry = Some(1);
    let refused = Numbering::opencode(&falling, &newest()).unwrap_err();
    assert!(refused.starts_with("invalid_messages:"), "{refused}");
}

#[test]
fn a_transcript_without_compactions_changes_no_number() {
    let store = Store::new("identity");
    store.summary(0, (1, "u1"), (2, "a2"));
    let plain = vec![
        HostMessage {
            mid: "u1".into(),
            entry: Some(1),
            finished_summary: false,
            added: false,
            pi: None,
        },
        HostMessage {
            mid: "a2".into(),
            entry: Some(2),
            finished_summary: false,
            added: false,
            pi: None,
        },
    ];
    let numbering = Numbering::opencode(&plain, &Cursor::new(2, "a2", "d")).unwrap();
    assert!(numbering.is_identity());
    run(&store, &numbering).unwrap();
    assert_eq!(
        store.query::<String>("SELECT start_message || '-' || end_message FROM compartments"),
        ["1-2"]
    );
}

/// The same transcript after its store is converted to OpenCode 2: the
/// compaction pair is one marker row, a delegated-task prompt and its answer
/// are gone, user message u6 gets a `synthetic` row with a new id right after
/// it, and a `system` notice is added at the end. The plugin numbered the
/// OpenCode 1 rows 1, 2, 3, 4 (opener), 5 (task), 6 (task answer), 7 (u6),
/// 8 (a7); the runner's entries are 1, 2, 3, -, -, -, 4 (u6), 5 (its added
/// row), 6 (a7), 7 (the notice).
fn converted() -> Vec<HostMessage> {
    let row = |mid: &str, entry: Option<u64>, finished_summary: bool, added: bool| HostMessage {
        mid: mid.into(),
        entry,
        finished_summary,
        added,
        pi: None,
    };
    vec![
        row("u1", Some(1), false, false),
        row("a2", Some(2), false, false),
        row("u3", Some(3), false, false),
        row("opener", None, false, false),
        row("summary", None, true, false),
        row("task", None, false, false),
        row("task-answer", None, false, false),
        row("u6", Some(4), false, false),
        row("u6-synthetic", Some(5), false, true),
        row("a7", Some(6), false, false),
        row("notice", Some(7), false, true),
    ]
}

#[test]
fn a_store_converted_to_opencode_2_maps_by_id_and_rows_added_after_a_message_count_with_it() {
    let store = Store::new("converted");
    store.summary(0, (1, "u1"), (3, "u3"));
    store.summary(1, (4, "opener"), (7, "u6"));
    store.summary(2, (8, "a7"), (8, "a7"));
    let conn = store.conn();
    conn.execute_batch(&format!(
        "INSERT INTO notes (type, content, session_id, created_at, updated_at, harness, anchor_ordinal)
             VALUES ('session', 'after u6', '{SESSION}', 1, 1, '{HARNESS}', 7),
                    ('session', 'at the task', '{SESSION}', 1, 1, '{HARNESS}', 5);"
    ))
    .unwrap();
    let numbering = Numbering::opencode(&converted(), &Cursor::new(7, "notice", "d")).unwrap();
    assert!(!numbering.is_identity());
    run(&store, &numbering).unwrap();
    // The summary ending at u6 also covers its added synthetic row, so that
    // text doesn't show raw after the cut; the last one covers the notice.
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-3", "4-5", "6-7"]
    );
    assert_eq!(
        store.query::<i64>("SELECT anchor_ordinal FROM notes ORDER BY id"),
        [5, 3]
    );
}

#[test]
fn an_added_row_cannot_be_a_finished_summary() {
    let mut rows = converted();
    rows[8].finished_summary = true;
    let refused = Numbering::opencode(&rows, &Cursor::new(7, "notice", "d")).unwrap_err();
    assert!(refused.starts_with("invalid_messages:"), "{refused}");
}

/// A Pi branch, root to leaf, with the runner's entries. The plugin numbers
/// it 1 u1, 2 a2, 3 b5 (a bashExecution message takes a number while the
/// results before it wait), 4 u6 (with t3 and t4 folded in, and the custom
/// message after it), 5 a8, 6 synth-user-t9 (a result run with no user
/// message after it), 7 a10 (with the result without a call id after it),
/// 8 u13, 9 a14. The runner counts every message entry and the custom
/// message, and neither the model change nor the compaction.
fn pi_branch() -> Vec<HostMessage> {
    let row =
        |mid: &str, entry: Option<u64>, kind: &str, role: Option<&str>, call: bool| HostMessage {
            mid: mid.into(),
            entry,
            finished_summary: false,
            added: false,
            pi: Some(PiRow {
                kind: kind.into(),
                role: role.map(Into::into),
                has_tool_call_id: call,
            }),
        };
    let message =
        |mid: &str, entry: u64, role: &str| row(mid, Some(entry), "message", Some(role), false);
    vec![
        row("mc", None, "model_change", None, false),
        message("u1", 1, "user"),
        message("a2", 2, "assistant"),
        row("t3", Some(3), "message", Some("toolResult"), true),
        row("t4", Some(4), "message", Some("toolResult"), true),
        message("b5", 5, "bashExecution"),
        message("u6", 6, "user"),
        row("cm7", Some(7), "custom_message", None, false),
        message("a8", 8, "assistant"),
        row("t9", Some(9), "message", Some("toolResult"), true),
        message("a10", 10, "assistant"),
        row("t11", Some(11), "message", Some("toolResult"), false),
        row("c12", None, "compaction", None, false),
        message("u13", 12, "user"),
        message("a14", 13, "assistant"),
        row("label", None, "label", None, false),
    ]
}

fn pi_newest() -> Cursor {
    Cursor::new(13, "a14", "d")
}

fn pi_summary(
    store: &Store,
    sequence: i64,
    (start, start_id): (i64, &str),
    (end, end_id): (i64, &str),
) {
    store
        .conn()
        .execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                 start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 't', 'c', 'c', 1, 'pi')",
            params![SESSION, sequence, start, end, start_id, end_id],
        )
        .unwrap();
}

fn pi_run(store: &Store) -> Result<(), String> {
    let mut conn = store.conn();
    let numbering = Numbering::pi(&pi_branch(), &pi_newest())?.align_pi(&conn, "pi", SESSION)?;
    renumber(&mut conn, "pi", SESSION, &numbering)
}

#[test]
fn a_pi_branch_maps_folded_results_and_skipped_entries_to_the_message_they_belong_to() {
    let store = Store::new("pi");
    pi_summary(&store, 0, (1, "u1"), (4, "u6"));
    pi_summary(&store, 1, (5, "a8"), (6, "synth-user-t9"));
    pi_summary(&store, 2, (7, "a10"), (9, "a14"));
    store
        .conn()
        .execute_batch(&format!(
            "INSERT INTO message_history_source (session_id, message_id, message_ordinal, source_version, normalized_content_hash, role, harness, updated_at)
                 VALUES ('{SESSION}', 'u6', 4, 'v', 'h', 'user', 'pi', 1),
                        ('{SESSION}', 'synth-user-t9', 6, 'v', 'h', 'user', 'pi', 1),
                        ('{SESSION}', 'a14', 9, 'v', 'h', 'assistant', 'pi', 1);
             INSERT INTO notes (type, content, session_id, created_at, updated_at, harness, anchor_ordinal)
                 VALUES ('session', 'n', '{SESSION}', 1, 1, 'pi', 7);"
        ))
        .unwrap();
    pi_run(&store).unwrap();

    // u6's summary also covers the results folded into it (3, 4) and the
    // custom message after it (7); a10's covers the result without a call id.
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-7", "8-9", "10-13"]
    );
    assert_eq!(
        store.query::<String>(
            "SELECT message_id || ':' || message_ordinal FROM message_history_source ORDER BY message_ordinal"
        ),
        ["u6:6", "synth-user-t9:9", "a14:13"]
    );
    assert_eq!(store.query::<i64>("SELECT anchor_ordinal FROM notes"), [11]);
}

#[test]
fn pi_numbers_stored_ahead_of_a_branch_that_lost_entries_are_lined_up_first() {
    let store = Store::new("pi-offset");
    // One message before u1 is gone from the file, so the plugin numbered
    // the branch from 2, behind a number for the lost message.
    pi_summary(&store, 0, (1, "lost"), (5, "u6"));
    pi_summary(&store, 1, (6, "a8"), (7, "synth-user-t9"));
    pi_summary(&store, 2, (8, "a10"), (10, "a14"));
    pi_run(&store).unwrap();
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-7", "8-9", "10-13"]
    );
}

#[test]
fn a_pi_summary_the_branch_cannot_place_refuses_and_changes_nothing() {
    let store = Store::new("pi-unanchored");
    pi_summary(&store, 0, (1, "u1"), (4, "elsewhere"));
    let error = pi_run(&store).unwrap_err();
    assert!(error.starts_with("ordinal_unanchored:"), "{error}");
    let store = Store::new("pi-disagree");
    pi_summary(&store, 0, (1, "u1"), (4, "u6"));
    // Its end says offset 0, its start says 1.
    pi_summary(&store, 1, (6, "a8"), (6, "synth-user-t9"));
    let error = pi_run(&store).unwrap_err();
    assert!(error.starts_with("ordinal_unanchored:"), "{error}");
    assert_eq!(
        store.query::<String>(
            "SELECT start_message || '-' || end_message FROM compartments ORDER BY sequence"
        ),
        ["1-4", "6-6"]
    );
}

#[test]
fn a_pi_list_must_say_what_each_entry_is_and_end_at_the_newest_message() {
    let mut rows = pi_branch();
    rows[1].pi = None;
    assert!(Numbering::pi(&rows, &pi_newest())
        .unwrap_err()
        .starts_with("invalid_messages:"));
    let mut rows = pi_branch();
    rows.truncate(rows.len() - 3);
    assert!(Numbering::pi(&rows, &pi_newest())
        .unwrap_err()
        .starts_with("invalid_messages:"));
}
