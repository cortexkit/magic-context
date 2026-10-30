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
