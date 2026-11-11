//! Exercise the export reader against the real writer's synthetic database.
#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

#[path = "../src/db/broca_run_index.rs"]
mod broca_export;
use broca_export::BrocaRunIndex;
use rusqlite::{params, Connection, OpenFlags};

fn fixture() -> (tempfile::TempDir, Connection, Connection) {
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("export.db");
    std::fs::copy(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/broca-export-facts/fixture-run-index.db"
        ),
        &path,
    )
    .unwrap();
    let writer = Connection::open(&path).unwrap();
    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    (folder, writer, reader)
}

fn poll(index: &mut BrocaRunIndex, conn: &Connection) -> broca_export::PollStats {
    let stats = index.refresh(conn).unwrap();
    assert!(conn.is_autocommit(), "a poll must release its snapshot");
    stats
}

#[test]
fn broca_export_fixture_lists_exactly_four_sessions_without_private_tables() {
    isolated_home();
    let (_folder, _writer, reader) = fixture();
    let mut index = BrocaRunIndex::default();
    let stats = poll(&mut index, &reader);
    assert_eq!((stats.rows_read, stats.skipped_invalid), (8, 0));
    let listed = index.list(10);
    assert_eq!(
        listed
            .iter()
            .map(|s| s.summary.session.session.as_str())
            .collect::<Vec<_>>(),
        [
            "synthetic-error-session",
            "synthetic-worker",
            "synthetic-agent-head",
            "synthetic-legacy-session"
        ]
    );
    let head = &listed[2];
    assert_eq!(head.summary.session.project_root, None);
    assert_eq!((head.summary.run_count, head.summary.slice_count), (1, 2));
    assert_eq!(head.activity, Some(1_700_000_003_200));
    assert_eq!(head.summary.first_activity_ms, head.activity);
    assert_eq!(head.summary.usage.input_tokens, Some(21));
    assert_eq!(head.summary.usage.cached_input_tokens, Some(0));
    assert_eq!(head.summary.usage.cache_write_tokens, Some(6));
    assert_eq!(head.summary.usage.output_tokens, Some(4));
    assert_eq!(head.summary.warm_usage.input_tokens, Some(1));
    assert_eq!(head.summary.warm_usage.cached_input_tokens, Some(20));
    assert_eq!(head.summary.warm_usage.output_tokens, Some(0));
    assert_eq!(head.summary.warm_usage.cache_write_tokens, None);
    assert_eq!(index.run_ids(&head.identity), ["run-fixture-3"]);
    assert_eq!(head.summary.last_end_reason.as_deref(), Some("completed"));
    assert_eq!(listed[0].summary.last_end_reason.as_deref(), Some("error"));
    let legacy = &listed[3].summary;
    assert_eq!((legacy.run_count, legacy.slice_count), (2, 2));
    assert_eq!(legacy.first_activity_ms, Some(1_700_000_001_200));
    assert_eq!(legacy.last_activity_ms, Some(1_700_000_002_200));
    assert_eq!(legacy.usage.input_tokens, Some(20));
    assert_eq!(legacy.usage.output_tokens, Some(4));
    assert_eq!(
        legacy.models,
        [
            "synthetic-provider/synthetic-model-1",
            "synthetic-provider/synthetic-model-2"
        ]
    );
    assert_eq!(index.summary(&listed[3].identity).unwrap(), *legacy);
}

#[test]
fn broca_export_gap_idle_poll_and_later_append_follow_the_cursor() {
    isolated_home();
    let (_folder, writer, reader) = fixture();
    let mut index = BrocaRunIndex::default();
    assert_eq!(poll(&mut index, &reader).rows_read, 8);
    let before = index.list(10);
    assert_eq!(poll(&mut index, &reader).rows_read, 0);
    assert_eq!(index.list(10), before);
    // Reuse a writer-produced fact, changing only the edge case under test.
    // Export order is intentionally later while activity is earlier.
    writer
        .execute_batch(
            "INSERT INTO export_facts (fact_id, run_id, segment_json)
        SELECT 'later-append', 'later-run', json_set(segment_json,
            '$.run_id', 'later-run', '$.occurred_at_ms', 1700000000000,
            '$.terminal_reason', 'cancelled', '$.future_member', 'ignored')
        FROM export_facts WHERE export_seq = 1;",
        )
        .unwrap();
    assert_eq!(poll(&mut index, &reader).rows_read, 1);
    let after = index.list(10);
    assert_eq!(after[3].summary.run_count, 3);
    assert_eq!(
        after[3].summary.last_end_reason.as_deref(),
        Some("completed")
    );
    assert_eq!(after[3].activity, before[3].activity);
    assert_eq!(poll(&mut index, &reader).rows_read, 0);
}

#[test]
fn broca_export_instance_and_epoch_each_reset_accumulated_sessions() {
    isolated_home();
    let (_folder, writer, reader) = fixture();
    let mut index = BrocaRunIndex::default();
    poll(&mut index, &reader);
    for (column, value) in [
        ("source_instance_id", "replacement-instance"),
        ("source_epoch", "2"),
    ] {
        // A different source can reuse the same sequence numbers.
        writer
            .execute_batch("DELETE FROM export_facts WHERE export_seq != 7;")
            .unwrap();
        writer
            .execute(
                &format!("UPDATE export_meta SET {column} = ?1 WHERE id = 1"),
                params![value],
            )
            .unwrap();
        assert_eq!(poll(&mut index, &reader).rows_read, 1);
        let listed = index.list(10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].summary.session.session, "synthetic-worker");
        assert_eq!(listed[0].summary.run_count, 1);
    }
}

#[test]
fn broca_export_full_identity_unknown_usage_null_time_and_bad_json() {
    isolated_home();
    let (_folder, writer, reader) = fixture();
    writer.execute_batch("INSERT INTO export_facts (fact_id, run_id, segment_json)
        SELECT 'unknown-usage', 'unknown-run', json_set(segment_json,
            '$.session.session', 'undated', '$.occurred_at_ms', NULL, '$.usage', json('{}'))
        FROM export_facts WHERE export_seq = 1;
        INSERT INTO export_facts (fact_id, run_id, segment_json)
        SELECT 'scoped-head', 'scoped-run', json_set(segment_json,
            '$.session.project_root', '/another-project') FROM export_facts WHERE export_seq = 4;
        INSERT INTO export_facts (fact_id, run_id, segment_json)
        SELECT 'other-harness', 'other-run', json_set(segment_json,
            '$.session.harness', 'another-harness') FROM export_facts WHERE export_seq = 4;
        INSERT INTO export_facts (fact_id, run_id, segment_json) VALUES ('bad', 'bad', '{');
        INSERT INTO export_facts (fact_id, run_id, segment_json) VALUES ('wrong-shape', 'bad', '{\"session\":42}');").unwrap();
    let mut index = BrocaRunIndex::default();
    let stats = poll(&mut index, &reader);
    assert_eq!((stats.rows_read, stats.skipped_invalid), (13, 2));
    let listed = index.list(20);
    assert_eq!(listed.len(), 7);
    let last = listed.last().unwrap();
    assert_eq!(last.summary.session.session, "undated");
    assert_eq!(last.activity, None);
    assert_eq!(last.summary.first_activity_ms, None);
    assert_eq!(last.summary.last_end_reason, None);
    assert_eq!(last.summary.usage.input_tokens, None);
    assert_eq!(last.summary.usage.output_tokens, None);
    assert_eq!(
        listed
            .iter()
            .filter(|s| s.summary.session.session == "synthetic-agent-head")
            .count(),
        3
    );
    assert_eq!(poll(&mut index, &reader).skipped_invalid, 0);
}

#[test]
fn broca_export_reader_never_queries_the_private_run_table() {
    isolated_home();
    let forbidden =
        regex::Regex::new(r#"(?i)\b(?:from|join|update|into|table)\s+[`"\[]?run_index\b"#).unwrap();
    for source in [
        include_str!("../src/db/broca_run_index.rs"),
        include_str!("../src/db.rs"),
    ] {
        assert!(
            !forbidden.is_match(source),
            "a Broca query names the private run table"
        );
    }
}

#[test]
fn broca_export_pages_past_a_full_batch_without_recounting() {
    isolated_home();
    let (_folder, writer, reader) = fixture();
    writer
        .execute_batch(
            "WITH RECURSIVE numbers(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 513
    ) INSERT INTO export_facts (fact_id, run_id, segment_json)
      SELECT 'paged-fact-' || n, 'paged-run-' || n,
             json_set(segment_json, '$.run_id', 'paged-run-' || n)
      FROM numbers CROSS JOIN export_facts WHERE export_seq = 1;",
        )
        .unwrap();
    let mut index = BrocaRunIndex::default();
    assert_eq!(poll(&mut index, &reader).rows_read, 521);
    let listed = index.list(10);
    let legacy = listed
        .iter()
        .find(|s| s.summary.session.session == "synthetic-legacy-session")
        .unwrap();
    assert_eq!(legacy.summary.run_count, 515);
    assert_eq!(legacy.summary.usage.input_tokens, Some(5150));
    assert_eq!(poll(&mut index, &reader).rows_read, 0);
    assert_eq!(index.list(10), listed);
}
