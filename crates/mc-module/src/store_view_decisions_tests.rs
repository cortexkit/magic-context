//! mode3.db version 7: each view decision in its own `view_decisions` row,
//! moved there from version 6's per-session lists, and deleted once it has
//! been kept for the retention period.

use super::*;
use serde_json::{json, Value};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// A decision record with every field ck-mc writes, made `age_ms` ago.
fn record(version: u64, status: &str, age_ms: u64) -> Value {
    json!({
        "view_version": version, "view_checksum": format!("checksum-{version}"), "status": status,
        "producer_ref": null, "at_ms": crate::app_read::now_ms() - age_ms, "decision": "publish",
        "cause": "history_refresh", "changes": {"model": null, "system_prompt": null, "tool_set": null},
        "dropped_count": version, "dropped_tokens": version * 10, "emergency": false,
        "identity_delta": [], "input_tokens": null, "materialized": false,
    })
}

/// The schema of every table and index, for comparing two stores.
fn schema(path: &Path) -> Vec<(String, String, String, Option<String>)> {
    Connection::open(path)
        .unwrap()
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Every stored row: its key, `at_ms` column and record.
fn rows(path: &Path) -> Vec<(String, String, u64, u64, Value)> {
    Connection::open(path)
        .unwrap()
        .prepare(
            "SELECT harness, session, view_version, at_ms, record FROM view_decisions
              ORDER BY harness, session, view_version",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                serde_json::from_str(&row.get::<_, String>(4)?).unwrap(),
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Turn a new store into a version-6 one: the per-session decision lists,
/// with the table version 6 created, in place of the version-7 rows.
fn version_six(path: &Path) {
    drop(Store::open(path).unwrap());
    Connection::open(path)
        .unwrap()
        .execute_batch(
            "DROP TABLE view_decisions;
             CREATE TABLE IF NOT EXISTS app_read_decisions (
                 runner TEXT NOT NULL,
                 harness TEXT NOT NULL,
                 session TEXT NOT NULL,
                 decisions TEXT NOT NULL,
                 PRIMARY KEY(runner,harness,session)
             );
             PRAGMA user_version = 6;",
        )
        .unwrap();
}

#[test]
fn a_version_six_store_moves_every_decision_record_into_its_own_row() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    version_six(&path);
    let one = vec![
        record(1, "applied", 3_000),
        record(2, "refused", 2_000),
        record(3, "offered", 1_000),
    ];
    let two = vec![record(5, "accepted", 500), record(6, "undelivered", 400)];
    let repeated = vec![record(4, "offered", 300), record(4, "applied", 200)];
    let unkeyed = vec![
        json!({"status": "offered", "at_ms": 1}),
        record(9, "applied", 100),
    ];
    let lists = [
        ("pi", "one", serde_json::to_string(&one).unwrap()),
        ("opencode2", "two", serde_json::to_string(&two).unwrap()),
        ("pi", "repeated", serde_json::to_string(&repeated).unwrap()),
        ("pi", "unkeyed", serde_json::to_string(&unkeyed).unwrap()),
        ("pi", "broken", "not JSON".to_owned()),
        ("pi", "empty", "[]".to_owned()),
    ];
    let connection = Connection::open(&path).unwrap();
    for (harness, session, decisions) in &lists {
        connection
            .execute(
                "INSERT INTO app_read_decisions VALUES ('runner', ?1, ?2, ?3)",
                params![harness, session, decisions],
            )
            .unwrap();
    }
    drop(connection);

    let store = Store::open(&path).unwrap();
    let version: u32 = store
        .lock()
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 7);
    let expected: Vec<(String, String, u64, u64, Value)> = [
        ("opencode2", "two", &two[0]),
        ("opencode2", "two", &two[1]),
        ("pi", "one", &one[0]),
        ("pi", "one", &one[1]),
        ("pi", "one", &one[2]),
        // The later of the two records of view 4, the newer one.
        ("pi", "repeated", &repeated[1]),
        ("pi", "unkeyed", &unkeyed[1]),
    ]
    .into_iter()
    .map(|(harness, session, record)| {
        (
            harness.to_owned(),
            session.to_owned(),
            record["view_version"].as_u64().unwrap(),
            record["at_ms"].as_u64().unwrap(),
            record.clone(),
        )
    })
    .collect();
    assert_eq!(
        rows(&path),
        expected,
        "every keyed record, with every field"
    );
    assert_eq!(
        store.app_decisions(&SessionRef::new("runner", "pi", "one")),
        one
    );
    assert_eq!(
        store.app_decisions(&SessionRef::new("runner", "opencode2", "two")),
        two
    );
    drop(store);

    let fresh = dir.path().join("fresh.db");
    drop(Store::open(&fresh).unwrap());
    assert_eq!(schema(&path), schema(&fresh));
    assert!(!schema(&path)
        .iter()
        .any(|(_, name, _, _)| name == "app_read_decisions"));
}

#[test]
fn a_session_holds_its_newest_decisions_and_clearing_it_deletes_its_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let store = Store::open(&path).unwrap();
    let key = SessionRef::new("runner", "pi", "busy");
    let other = SessionRef::new("runner", "pi", "other");
    let records: Vec<Value> = (1..=300).map(|v| record(v, "applied", 1_000)).collect();
    let writes: Vec<_> = records
        .iter()
        .map(|record| (DecisionWrite::Offered, record))
        .collect();
    store.save_app_decisions(&key, &writes).unwrap();
    store
        .save_app_decisions(&other, &[(DecisionWrite::Offered, &records[0])])
        .unwrap();
    assert_eq!(store.take_decision_writes(), (301, 0));
    assert_eq!(
        store.app_decisions(&key),
        records[300 - VIEW_DECISIONS_IN_MEMORY..]
    );
    assert_eq!(
        view_decision(&store.lock(), &key, 1).unwrap(),
        Some(records[0].clone()),
        "older records stay in the table"
    );

    // A status change updates the one row; a record with no row is not
    // created by one.
    let mut changed = records[9].clone();
    changed["status"] = json!("refused");
    let unknown = record(999, "refused", 0);
    store
        .save_app_decisions(
            &key,
            &[
                (DecisionWrite::StatusChanged, &changed),
                (DecisionWrite::StatusChanged, &unknown),
            ],
        )
        .unwrap();
    assert_eq!(store.take_decision_writes(), (0, 1));
    assert_eq!(
        view_decision(&store.lock(), &key, 10).unwrap(),
        Some(changed)
    );
    assert_eq!(view_decision(&store.lock(), &key, 999).unwrap(), None);

    store.clear_session(&key).unwrap();
    assert!(store.app_decisions(&key).is_empty());
    assert!(!store.has_rows(&key).unwrap());
    assert_eq!(store.app_decisions(&other), records[..1]);
}

#[test]
fn expired_decisions_are_deleted_when_the_store_opens_and_at_most_hourly_after() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let key = SessionRef::new("runner", "pi", "aging");
    let store = Store::open(&path).unwrap();
    let expired = record(1, "applied", 31 * DAY_MS);
    let kept = record(2, "applied", 29 * DAY_MS);
    store
        .save_app_decisions(
            &key,
            &[
                (DecisionWrite::Offered, &expired),
                (DecisionWrite::Offered, &kept),
            ],
        )
        .unwrap();
    let versions = |path: &Path| -> Vec<u64> {
        rows(path)
            .into_iter()
            .map(|(_, _, version, _, _)| version)
            .collect()
    };
    assert_eq!(
        versions(&path),
        [1, 2],
        "a write within the hour deletes none"
    );
    drop(store);

    let store = Store::open(&path).unwrap();
    assert_eq!(
        versions(&path),
        [2],
        "opening the store deletes expired rows"
    );

    let late = record(3, "applied", 31 * DAY_MS);
    store
        .save_app_decisions(&key, &[(DecisionWrite::Offered, &late)])
        .unwrap();
    assert_eq!(versions(&path), [2, 3]);
    *store.decisions_pruned.lock().unwrap() = std::time::Instant::now()
        .checked_sub(VIEW_DECISION_PRUNE_EVERY)
        .unwrap();
    let recent = record(4, "offered", 0);
    store
        .save_app_decisions(&key, &[(DecisionWrite::Offered, &recent)])
        .unwrap();
    assert_eq!(
        versions(&path),
        [2, 4],
        "an hour on, a write deletes them too"
    );
    assert!(store.decisions_pruned.lock().unwrap().elapsed() < VIEW_DECISION_PRUNE_EVERY);
}
