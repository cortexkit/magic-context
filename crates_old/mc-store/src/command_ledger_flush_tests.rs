use super::tests::fixture;
use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn freeze(core: &mut crate::CoreState, target: &str) {
    core.frozen_units.push(crate::FrozenUnit {
        key: format!("red:{target}"),
        kind: "agent_drop".into(),
        frozen_payload: String::new(),
        durability_class: crate::DurabilityClass::Lineage,
        reset_rule: String::new(),
    });
}

#[test]
fn completed_flush_tracks_real_applied_counts_across_partial_cas_and_reopen() {
    let (store, dir) = fixture();
    let mut core = crate::CoreState::default();
    freeze(&mut core, "already");
    store
        .commit("a", None, &core, &crate::ModuleMeta::default())
        .unwrap();
    store
        .append_pending_agent_drops(
            "a",
            &[
                "one".into(),
                "two".into(),
                "already".into(),
                "obsolete".into(),
            ],
            1,
        )
        .unwrap();
    store.ops_flush("a", "flush", true, 2).unwrap();
    let foreign = store.ops_flush("b", "other", true, 2).unwrap();
    let loaded = store.load("a").unwrap();
    let pending = store.load_pending_agent_drops("a").unwrap();
    let first = pending.iter().find(|d| d.target_id == "one").unwrap().id;
    let mut core = loaded.core;
    freeze(&mut core, "one");
    let mut meta = loaded.meta;
    meta.soft_refresh_pending = false;
    let version = store
        .commit_with_consumed_drops("a", loaded.row_version, &core, &meta, &[first], None)
        .unwrap();
    let partial = store.ops_job("a", Some("flush"), None).unwrap().unwrap();
    assert_eq!(partial["state"], "armed");
    assert_eq!(partial["result"]["queued_drops"]["applied_count"], 1);
    assert_eq!(partial["result"]["queued_drops"]["remaining_count"], 3);
    assert!(store
        .commit_with_consumed_drops("a", loaded.row_version, &core, &meta, &[first], None)
        .is_err());
    assert_eq!(
        store.ops_job("a", Some("flush"), None).unwrap().unwrap(),
        partial
    );
    freeze(&mut core, "two");
    let rest: Vec<_> = pending
        .iter()
        .filter(|d| d.id != first)
        .map(|d| d.id)
        .collect();
    store
        .commit_with_consumed_drops("a", Some(version), &core, &meta, &rest, None)
        .unwrap();
    let done = store.ops_job("a", Some("flush"), None).unwrap().unwrap();
    assert_eq!(done["state"], "drained");
    assert_eq!(done["result"]["queued_drops"]["applied_count"], 2);
    assert_eq!(done["result"]["queued_drops"]["remaining_count"], 0);
    assert_eq!(
        store.ops_job("b", Some("other"), None).unwrap().unwrap(),
        foreign
    );
    assert_eq!(
        store.ops_events("a", 0, 64).unwrap()["events"][0]["job"],
        done
    );
    drop(store);
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap();
    assert_eq!(store.ops_flush("a", "flush", true, 99).unwrap(), done);
    assert!(store.load_pending_agent_drops("a").unwrap().is_empty());
}

#[test]
fn flush_ack_failure_rolls_back_cache_queue_and_counts() {
    let (store, _dir) = fixture();
    store
        .append_pending_agent_drops("a", &["one".into()], 1)
        .unwrap();
    let armed = store.ops_flush("a", "flush", true, 2).unwrap();
    let loaded = store.load("a").unwrap();
    let pending = store.load_pending_agent_drops("a").unwrap();
    let mut core = loaded.core.clone();
    freeze(&mut core, "one");
    let mut meta = loaded.meta.clone();
    meta.soft_refresh_pending = false;
    store.inner.with_conn(|db| db.execute_batch("CREATE TRIGGER reject_flush_ack BEFORE UPDATE ON mc_ops_commands WHEN json_extract(new.job,'$.state')='drained' BEGIN SELECT RAISE(ABORT,'fixture ack failure'); END")).unwrap();
    assert!(store
        .commit_with_consumed_drops(
            "a",
            loaded.row_version,
            &core,
            &meta,
            &[pending[0].id],
            None
        )
        .is_err());
    assert_eq!(store.load("a").unwrap().row_version, loaded.row_version);
    assert_eq!(
        store.load("a").unwrap().core.frozen_units,
        loaded.core.frozen_units
    );
    assert_eq!(store.load_pending_agent_drops("a").unwrap().len(), 1);
    assert_eq!(
        store.ops_job("a", Some("flush"), None).unwrap().unwrap(),
        armed
    );
    store
        .inner
        .with_conn(|db| db.execute_batch("DROP TRIGGER reject_flush_ack"))
        .unwrap();
    store
        .commit_with_consumed_drops(
            "a",
            loaded.row_version,
            &core,
            &meta,
            &[pending[0].id],
            None,
        )
        .unwrap();
    assert_eq!(
        store.ops_job("a", Some("flush"), None).unwrap().unwrap()["result"]["queued_drops"]
            ["applied_count"],
        1
    );
}

#[test]
fn zero_drop_flush_waits_for_refresh_and_does_not_complete_superseded_jobs() {
    let (store, _dir) = fixture();
    store.ops_flush("a", "old", true, 1).unwrap();
    store.ops_flush("a", "active", true, 2).unwrap();
    let old = store.ops_job("a", Some("old"), None).unwrap().unwrap();
    assert_eq!(old["state"], "superseded");
    let loaded = store.load("a").unwrap();
    let v = store
        .commit("a", loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    assert_eq!(
        store.ops_job("a", Some("active"), None).unwrap().unwrap()["state"],
        "armed"
    );
    let mut meta = loaded.meta;
    meta.soft_refresh_pending = false;
    store.commit("a", Some(v), &loaded.core, &meta).unwrap();
    let done = store.ops_job("a", Some("active"), None).unwrap().unwrap();
    assert_eq!(done["state"], "drained");
    assert_eq!(done["result"]["queued_drops"]["applied_count"], 0);
    assert_eq!(store.ops_job("a", Some("old"), None).unwrap().unwrap(), old);
}
