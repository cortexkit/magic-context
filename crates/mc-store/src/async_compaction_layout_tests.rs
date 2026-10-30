use super::*;
use crate::McStore;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn store(path: &std::path::Path) -> McStore {
    McStore::open(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}

fn seed_legacy(store: &McStore, reference: &str) -> String {
    let initial = json!({"answer":"ready","initial":{"replacement":[{"role":"assistant","text":"exact prepared bytes"}]}});
    let raw = json!({"initial":initial,"standalone_move":{"bound_drops":[{"mid":"m0","part":"0","digest":"abc","kind":"Applied"}]}}).to_string();
    store.inner.with_conn_fenced(|conn| {
        conn.execute("INSERT INTO main.mc_async_compaction VALUES(?1,?2,?3,?4,7)",params![reference,format!("[\"runner\",\"{reference}\",\"opencode\"]"),reference,raw])?;
        conn.execute("INSERT INTO main.mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES(?1,?1,0,'{\"ordinal\":0,\"mid\":\"m0\"}','[]','m0')",[reference])?;
        conn.execute("INSERT INTO main.mc_async_compaction_views VALUES(?1,?1,7,'view bytes','engine bytes',0)",[reference])?;
        conn.execute("INSERT INTO main.mc_async_compaction_baselines VALUES(?1,?1,'produced','engine baseline')",[reference])?;
        Ok(())
    }).unwrap();
    raw
}

fn legacy_counts(store: &McStore, reference: &str) -> Vec<u64> {
    store
        .inner
        .with_conn(|conn| {
            [
                "mc_async_compaction",
                "mc_async_compaction_entries",
                "mc_async_compaction_views",
                "mc_async_compaction_baselines",
            ]
            .iter()
            .map(|table| {
                conn.query_row(
                    &format!("SELECT count(*) FROM main.{table} WHERE session_ref=?1"),
                    [reference],
                    |row| row.get(0),
                )
            })
            .collect()
        })
        .unwrap()
}

#[test]
fn review_migration_serializes_with_an_inflight_legacy_writer() {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(store(dir.path()));
    seed_legacy(&store, "concurrent");
    let mut writer = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
    let tx = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute("UPDATE main.mc_async_compaction SET state_json=json_set(state_json,'$.initial.writer','committed') WHERE session_ref='concurrent'", []).unwrap();
    tx.execute("INSERT INTO main.mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json,mid) VALUES('concurrent','concurrent',1,'{\"ordinal\":1,\"mid\":\"m1\"}','[]','m1')", []).unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let migrating = std::sync::Arc::clone(&store);
    let task = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        done_tx
            .send(migrating.load_async_compaction_rows("concurrent"))
            .unwrap();
    });
    started_rx.recv().unwrap();
    // A busy refusal is safe, but a successful migration while another writer
    // still owns the transaction would have copied stale state.
    let early = done_rx.recv_timeout(std::time::Duration::from_millis(100));
    if let Ok(result) = &early {
        assert!(
            result.is_err(),
            "migration committed while a legacy writer held SQLite's writer lock"
        );
    }
    tx.commit().unwrap();
    if early.is_err() {
        let _ = done_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
    }
    task.join().unwrap();
    let migrated = store
        .load_async_compaction_rows("concurrent")
        .unwrap()
        .unwrap();
    assert_eq!(migrated.entries.len(), 2);
    let initial = store
        .load_async_compaction_baseline("concurrent", "setup-initial")
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&initial).unwrap()["writer"],
        "committed"
    );
    assert_eq!(legacy_counts(&store, "concurrent"), vec![0, 0, 0, 0]);
}

#[test]
fn placement_lookup_selects_one_layout_and_keeps_two_index_searches() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    seed_legacy(&store, "placement");
    for migrated in [false, true] {
        if migrated {
            store.load_async_compaction("placement").unwrap();
        }
        store
            .inner
            .with_conn(|conn| {
                let sql = McStore::async_compaction_placement_sql(conn, "placement")?;
                assert_eq!(
                    sql,
                    if migrated {
                        KV_ENTRY_LOOKUP_SQL
                    } else {
                        ENTRY_LOOKUP_SQL
                    }
                );
                let plans = conn
                    .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
                    .query_map(params!["placement", "m0"], |row| row.get::<_, String>(3))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                assert_eq!(
                    plans.iter().filter(|plan| plan.contains("SEARCH")).count(),
                    2,
                    "{plans:?}"
                );
                assert!(plans.iter().all(|plan| !plan.contains("SCAN")), "{plans:?}");
                let result: (u64, String) =
                    conn.query_row(sql, params!["placement", "m0"], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?;
                assert_eq!(result, (0, "[]".into()));
                Ok(())
            })
            .unwrap();
    }
}

#[test]
fn inspection_json_updates_preserve_string_envelopes_and_source_revision() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    seed_legacy(&store, "json-update");
    store.load_async_compaction("json-update").unwrap();
    store.inner.with_conn(|conn| {
        install_views(conn)?;
        conn.execute_batch("UPDATE temp.mc_async_compaction SET state_json=json_set(state_json,'$.input_revision',7) WHERE session_ref='json-update';
          UPDATE temp.mc_async_compaction_entries SET entry_json=json_set(entry_json,'$.changed',true),index_json=json_array('index') WHERE session_ref='json-update';
          UPDATE temp.mc_async_compaction_views SET view_json=json_object('answer','ready'),engine_json=json_array('engine') WHERE session_ref='json-update';")?;
        let h = header(conn, "json-update")?.unwrap();
        let state: Value = serde_json::from_str(&h.state_json).unwrap();
        assert_eq!(state["input_revision"], 8);
        let entry = entries(conn, "json-update", 0, 10)?.pop().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&entry.entry_json).unwrap()["changed"], 1);
        assert_eq!(entry.index_json, "[\"index\"]");
        let view = views(conn, "json-update")?.pop().unwrap();
        assert_eq!(view.view_json, "{\"answer\":\"ready\"}");
        assert_eq!(view.engine_json.as_deref(), Some("[\"engine\"]"));
        Ok(())
    }).unwrap();
}

#[test]
fn legacy_family_migrates_atomically_without_exposing_a_cold_header_to_old_readers() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let raw = seed_legacy(&store, "migrated");
    seed_legacy(&store, "untouched");
    store.inner.with_conn(|conn| conn.execute_batch("CREATE TEMP TRIGGER interrupt_async_migration BEFORE DELETE ON main.mc_async_compaction WHEN OLD.session_ref='migrated' BEGIN SELECT RAISE(ABORT,'migration interrupted'); END")).unwrap();
    assert!(store.load_async_compaction("migrated").is_err());
    assert_eq!(legacy_counts(&store, "migrated"), vec![1, 1, 1, 1]);
    assert!(store
        .inner
        .with_conn(|conn| header(conn, "migrated").map(|header| header.is_none()))
        .unwrap());
    store
        .inner
        .with_conn(|conn| conn.execute_batch("DROP TRIGGER temp.interrupt_async_migration"))
        .unwrap();
    let migrated: Value =
        serde_json::from_str(&store.load_async_compaction("migrated").unwrap().unwrap()).unwrap();
    assert!(migrated.get("initial").is_none());
    assert_eq!(migrated["initial_stored"], true);
    let before: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &store
                .load_async_compaction_baseline("migrated", "setup-initial")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        before["initial"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(
            &store
                .load_async_compaction_baseline("migrated", "moved-bound-drops")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        before["standalone_move"]["bound_drops"]
    );
    assert_eq!(legacy_counts(&store, "migrated"), vec![0, 0, 0, 0]);
    assert_eq!(legacy_counts(&store, "untouched"), vec![1, 1, 1, 1]);
    assert_eq!(
        store.load_async_compaction_views("migrated").unwrap(),
        (
            vec![(7, "view bytes".into(), Some("engine bytes".into()), false)],
            7
        )
    );
    assert_eq!(
        store
            .load_async_compaction_rows("migrated")
            .unwrap()
            .unwrap()
            .entries
            .len(),
        1
    );
    assert_eq!(
        store
            .reserve_async_compaction_version("migrated", 3)
            .unwrap(),
        8
    );
    let old_pending = store
        .inner
        .with_conn(|conn| {
            conn.prepare(
                "SELECT session_ref FROM main.mc_async_compaction_views WHERE announced=0",
            )?
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert_eq!(old_pending, vec!["untouched"]);
}

#[test]
fn a_cold_slot_failure_rolls_back_the_kv_header_and_source_rows() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let mut first = store.async_compaction_save("ref", "key", "session", "{\"input_revision\":0}");
    first.baseline("setup-initial", Some("old answer".into()));
    first.append_entry(0, "old row".into(), "[]".into());
    first.commit().unwrap();
    store.inner.with_conn(|conn| conn.execute_batch("CREATE TEMP TRIGGER interrupt_async_slot BEFORE UPDATE ON main.mc_cache_sections WHEN NEW.section='setup-initial' BEGIN SELECT RAISE(ABORT,'slot interrupted'); END")).unwrap();
    let mut next = store.async_compaction_save("ref", "key", "session", "{\"input_revision\":1}");
    next.baseline("setup-initial", Some("new answer".into()));
    next.replace_entry(0, "new row".into(), "[]".into());
    assert!(next.commit().is_err());
    assert_eq!(
        store.load_async_compaction("ref").unwrap().unwrap(),
        "{\"input_revision\":0}"
    );
    assert_eq!(
        store
            .load_async_compaction_baseline("ref", "setup-initial")
            .unwrap()
            .unwrap(),
        "old answer"
    );
    assert_eq!(
        store.load_async_compaction_entries("ref", 0).unwrap(),
        vec![(0, "old row".into())]
    );
}

#[test]
fn offline_downgrade_is_lossless_atomic_per_session_and_resumable() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let originals = [seed_legacy(&store, "a"), seed_legacy(&store, "b")];
    store.migrate_async_compaction_records().unwrap();
    store.inner.with_conn_fenced(|conn| {
        put(conn, "engine:async:0", "head", "engine bytes, unchanged")?;
        put(conn, "engine:async:0", "tail", "tail bytes, unchanged")?;
        conn.execute_batch("CREATE TRIGGER interrupt_downgrade BEFORE INSERT ON mc_async_compaction WHEN NEW.session_ref='b' BEGIN SELECT RAISE(ABORT,'downgrade interrupted'); END")
    }).unwrap();
    let context = dir.path().join("context-untouched.db");
    std::fs::write(
        &context,
        b"context summaries, memories and tags must not be opened",
    )
    .unwrap();
    let path = dir.path().join("store.db");
    assert!(McStore::downgrade_async_layout_offline(&path).is_err());
    assert_eq!(legacy_counts(&store, "a"), vec![1, 1, 1, 1]);
    assert_eq!(legacy_counts(&store, "b"), vec![0, 0, 0, 0]);
    store
        .inner
        .with_conn(|conn| {
            assert!(header(conn, "a")?.is_none());
            assert!(header(conn, "b")?.is_some());
            conn.execute_batch("DROP TRIGGER interrupt_downgrade")
        })
        .unwrap();
    assert_eq!(
        McStore::downgrade_async_layout_offline(&path).unwrap(),
        vec!["b"]
    );
    assert!(McStore::downgrade_async_layout_offline(&path)
        .unwrap()
        .is_empty());
    store.inner.with_conn(|conn| {
        for (reference, original) in ["a", "b"].iter().zip(originals) {
            let state: String = conn.query_row("SELECT state_json FROM main.mc_async_compaction WHERE session_ref=?1", [reference], |row|row.get(0))?;
            assert_eq!(serde_json::from_str::<Value>(&state).unwrap(), serde_json::from_str::<Value>(&original).unwrap());
            let entry: (u64, String, String, String) = conn.query_row("SELECT ordinal,entry_json,index_json,mid FROM main.mc_async_compaction_entries WHERE session_ref=?1", [reference], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
            assert_eq!(entry, (0, "{\"ordinal\":0,\"mid\":\"m0\"}".into(), "[]".into(), "m0".into()));
            let view: (u64, String, String, i64) = conn.query_row("SELECT version,view_json,engine_json,announced FROM main.mc_async_compaction_views WHERE session_ref=?1", [reference], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
            assert_eq!(view, (7, "view bytes".into(), "engine bytes".into(), 0));
            let baseline: String = conn.query_row("SELECT view_json FROM main.mc_async_compaction_baselines WHERE session_ref=?1 AND slot='produced'", [reference], |row|row.get(0))?;
            assert_eq!(baseline, "engine baseline");
            assert_eq!(conn.query_row("SELECT count(*) FROM main.mc_cache_sections WHERE session_id=?1", [owner(reference)], |row|row.get::<_, u64>(0))?, 0);
        }
        assert_eq!(get(conn, "engine:async:0", "head")?.as_deref(), Some("engine bytes, unchanged"));
        assert_eq!(get(conn, "engine:async:0", "tail")?.as_deref(), Some("tail bytes, unchanged"));
        Ok(())
    }).unwrap();
    assert_eq!(
        std::fs::read(context).unwrap(),
        b"context summaries, memories and tags must not be opened"
    );
}
