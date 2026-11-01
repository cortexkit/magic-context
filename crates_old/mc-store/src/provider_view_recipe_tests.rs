//! Which stored view recipes pruning keeps, and a runner record that names its
//! view by version moving to another store through agent move.
use super::*;
use crate::move_snapshot as codec;
use crate::provider_log::{
    ProviderConversation, ProviderLineage, ProviderMessage, ProviderStatusPage,
};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use serde_json::json;

fn open(dir: &std::path::Path) -> McStore {
    McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}

fn key(session: &str, harness: &str) -> ProviderSessionKey {
    ProviderSessionKey {
        project_root: "/roots".into(),
        session: session.into(),
        harness: harness.into(),
        generation: None,
    }
}

/// A recipe that streams native message 0 of lineage L after a synthetic head.
fn recipe(version: u64, base: Option<u64>, state: &str) -> ProviderViewRecipe {
    ProviderViewRecipe {
        version,
        lineage_id: "L".into(),
        range_from: 0,
        range_to: 1,
        base_version: base,
        policy_cut_id: None,
        metadata: json!({ "version": version }),
        segments: vec![
            ProviderViewSegment::Synthetic {
                slot: "head".into(),
            },
            ProviderViewSegment::NativeRange {
                source_lineage_id: "L".into(),
                from: 0,
                to: 1,
                first_mid: "m".into(),
                last_mid: "m".into(),
            },
        ],
        synthetic: BTreeMap::from([("head".into(), json!({ "text": format!("head {version}") }))]),
        treatments: vec![],
        serializer_profile: "owned-broca".into(),
        render_key: "fixture-render".into(),
        tokenizer_key: "fixture-tokenizer".into(),
        state: state.into(),
    }
}

fn seed_conversation(store: &McStore, key: &ProviderSessionKey) {
    store
        .save_provider_conversation(
            key,
            &ProviderConversation {
                lineage_id: "L".into(),
                engine_namespace: format!("engine-{}", key.session),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .commit_provider_status_page(
            key,
            ProviderStatusPage {
                lineage: &ProviderLineage {
                    lineage_id: "L".into(),
                    first_ordinal: 0,
                    descends_from: None,
                    through_ordinal: None,
                },
                messages: &[ProviderMessage {
                    ordinal: 0,
                    mid: "m".into(),
                    message_bytes:
                        br#"{"role":"user","content":[{"type":"text","text":"native source"}]}"#
                            .to_vec(),
                }],
                served: Some(0),
                unserved: &[],
                newest: Some(0),
                more: false,
            },
        )
        .unwrap();
}

/// Every reference that can still replay a view keeps that view and the
/// native source it streams: the host Setup's acknowledged and produced views
/// (the produced one is replayed when the host reports it not applied), the
/// step receipt a retried request answers from, the two newest applied views,
/// the runner record's waiting view, and every ancestor of those. A stale
/// last-known-good counter is not a runtime view reference.
#[test]
fn v2_recipe_keeps_ack_receipt_source_roots() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let key = key("roots", "claude-code");
    seed_conversation(&store, &key);
    for version in 1..=9 {
        let state = if matches!(version, 2 | 3) {
            "applied"
        } else {
            "produced"
        };
        let base = (version == 8).then_some(4);
        store
            .save_provider_view_recipe(&key, &recipe(version, base, state))
            .unwrap();
    }
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "UPDATE mc_provider_conversations_v2 SET setup_json=?2,last_answer_json=?3,hook_counters_json=?4,legacy_shape_json=?5 WHERE conv_key=?1",
                params![
                    key.conversation_key(),
                    json!({"applied":{"version":3},"produced":{"version":5}}).to_string(),
                    json!({"answer":"compaction_message","compaction":{"version":6}}).to_string(),
                    json!({"lkg_view_versions":[8]}).to_string(),
                    json!({"wait_version":7}).to_string(),
                ],
            )
            .map(|_| ())
        })
        .unwrap();
    let roots = store.provider_view_source_roots(&key).unwrap();
    assert_eq!(roots.versions, BTreeSet::from([2, 3, 5, 6, 7]));
    assert_eq!(roots.sources, BTreeSet::from([("L".to_string(), 0, 1)]));
    assert_eq!(
        store.prune_provider_views_from_conversation(&key).unwrap(),
        4
    );
    assert_eq!(
        store.load_provider_view_recipe_versions(&key).unwrap(),
        vec![2, 3, 5, 6, 7],
        "stale last-known-good counter versions do not prevent pruning"
    );
    // Every live root still resolves after pruning, with its native source.
    for version in roots.versions {
        let resolved = store.resolve_provider_view(&key, version).unwrap().unwrap();
        assert_eq!(resolved.messages.len(), 1, "view {version} lost its source");
        assert_eq!(
            resolved.recipe.synthetic["head"],
            json!({ "text": format!("head {version}") })
        );
    }
}

fn set_answered(store: &McStore, key: &ProviderSessionKey, lineage: &str, version: Option<u64>) {
    let conversation = store.load_provider_conversation(key).unwrap().unwrap();
    let mut counters: Value = serde_json::from_str(&conversation.hook_counters_json).unwrap();
    record_lineage_answered_view(&mut counters, lineage, version);
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json=?2 WHERE conv_key=?1",
                params![key.conversation_key(), counters.to_string()],
            )
            .map(|_| ())
        })
        .unwrap();
}

fn roots(store: &McStore, key: &ProviderSessionKey) -> BTreeSet<u64> {
    store.provider_view_source_roots(key).unwrap().versions
}

/// The view each lineage was named in its newest step answer is a root while
/// that lineage is held; the lineage's next answer replaces or clears it, so
/// the older view is pruned, and removing the lineage releases it. The entries
/// live in the conversation row and survive a cold reopen.
#[test]
fn lineage_answered_views_are_roots_until_superseded_or_retired() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path());
    let key = key("lineages", "claude-code");
    seed_conversation(&store, &key);
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'F',1,'L',0,json_extract(?1,'$[1]'))",
                [key.conversation_key()],
            )
            .map(|_| ())
        })
        .unwrap();
    for version in 1..=4 {
        store
            .save_provider_view_recipe(&key, &recipe(version, None, "produced"))
            .unwrap();
    }
    set_answered(&store, &key, "L", Some(2));
    set_answered(&store, &key, "F", Some(3));
    assert_eq!(
        store.provider_lineage_answered_views(&key).unwrap(),
        BTreeMap::from([("F".to_string(), 3), ("L".to_string(), 2)])
    );
    assert_eq!(roots(&store, &key), BTreeSet::from([2, 3]));
    assert_eq!(
        store.prune_provider_views_from_conversation(&key).unwrap(),
        2
    );
    assert_eq!(
        store.load_provider_view_recipe_versions(&key).unwrap(),
        vec![2, 3]
    );

    // L steps again and is answered with view 5: its earlier view 2 goes.
    store
        .save_provider_view_recipe(&key, &recipe(5, None, "produced"))
        .unwrap();
    set_answered(&store, &key, "L", Some(5));
    assert_eq!(roots(&store, &key), BTreeSet::from([3, 5]));
    assert_eq!(
        store.prune_provider_views_from_conversation(&key).unwrap(),
        1
    );
    assert_eq!(
        store.load_provider_view_recipe_versions(&key).unwrap(),
        vec![3, 5]
    );
    // L steps again and the answer names no view: view 5 goes as well.
    set_answered(&store, &key, "L", None);
    assert_eq!(roots(&store, &key), BTreeSet::from([3]));
    assert_eq!(
        store.prune_provider_views_from_conversation(&key).unwrap(),
        1
    );
    assert_eq!(
        store.load_provider_view_recipe_versions(&key).unwrap(),
        vec![3]
    );

    // A cold reopen reads the same per-lineage roots from the conversation row.
    drop(store);
    let store = open(dir.path());
    assert_eq!(
        store.provider_lineage_answered_views(&key).unwrap(),
        BTreeMap::from([("F".to_string(), 3)])
    );
    assert_eq!(roots(&store, &key), BTreeSet::from([3]));

    // Removing lineage F releases its view even though the entry remains.
    store
        .save_provider_view_recipe(&key, &recipe(8, None, "produced"))
        .unwrap();
    set_answered(&store, &key, "L", Some(8));
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "DELETE FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id='F'",
                [key.conversation_key()],
            )
            .map(|_| ())
        })
        .unwrap();
    assert_eq!(
        store.provider_lineage_answered_views(&key).unwrap(),
        BTreeMap::from([("L".to_string(), 8)])
    );
    assert_eq!(roots(&store, &key), BTreeSet::from([8]));
    assert_eq!(
        store.prune_provider_views_from_conversation(&key).unwrap(),
        1
    );
    assert_eq!(
        store.load_provider_view_recipe_versions(&key).unwrap(),
        vec![8]
    );
}

fn move_binding(cut: &str) -> crate::move_store::CutBinding {
    crate::move_store::CutBinding {
        cut_id: cut.into(),
        session_ref: "0123456789abcdef".into(),
        host_session_id: "ses_move".into(),
        host_end_offset: 42,
        host_cut: json!({"lastMessageId":"msg_1","hostInputs":{"count":1,"digest":"abc"}}),
        mc_start_offset: 100,
    }
}

/// A runner record and its view recipe stored the way the module's record
/// writer stores them: the record names the view by version.
fn seed_runner_record(store: &McStore) -> ProviderSessionKey {
    let key = key("ses_move", "broca");
    store
        .commit(
            "ses_move",
            None,
            &Default::default(),
            &crate::ModuleMeta::default(),
        )
        .unwrap();
    let record = json!({
        "setup":{"request":{"lineage_id":"L","params":{}},"state":{"compaction_id":"c","version_high_water":4,"rebuild_epoch":0,
            "last_produced":{"version":4},"last_applied":{"version":4}}},
        "messages":{"L":{"0":{"ordinal":0,"mid":"m","message":{"role":"user","content":[{"type":"text","text":"native source"}]}}}},
        "last_answer":{"answer":"compaction_message","compaction":{"version":4}}
    });
    store
        .save_provider_record(
            &key,
            &record.to_string(),
            "ses_move",
            &[],
            &[recipe(4, None, "produced")],
        )
        .unwrap();
    key
}

#[test]
fn runner_record_view_recipe_moves_and_v7_section_streams_are_refused() {
    let source_dir = tempfile::tempdir().unwrap();
    let source = open(source_dir.path());
    let key = seed_runner_record(&source);
    let record = source.load_provider_record(&key).unwrap().unwrap();
    let record: Value = serde_json::from_str(&record).unwrap();
    assert_eq!(
        record["setup"]["state"]["last_applied"],
        json!({"version":4})
    );
    let view = source.resolve_provider_view(&key, 4).unwrap().unwrap();
    assert_eq!(view.recipe.state, "applied");

    let staging_dir = tempfile::tempdir().unwrap();
    let staging = staging_dir.path().join("staging");
    let mut export = source.move_store().unwrap();
    export.acquire_fence(&move_binding("cut")).unwrap();
    export.freeze("cut").unwrap();
    export.capture("cut", &staging).unwrap();

    // The current importer reproduces the record and its resolvable recipe.
    let target_dir = tempfile::tempdir().unwrap();
    let target = open(target_dir.path());
    let mut import = target.move_store().unwrap();
    import
        .reserve_install(&move_binding("cut"), "digest", &staging)
        .unwrap();
    while !import.install_batch("cut").unwrap().complete {}
    assert_eq!(
        serde_json::from_str::<Value>(&target.load_provider_record(&key).unwrap().unwrap())
            .unwrap(),
        record
    );
    let moved = target.resolve_provider_view(&key, 4).unwrap().unwrap();
    assert_eq!(moved.recipe.metadata, view.recipe.metadata);
    assert_eq!(moved.recipe.synthetic, view.recipe.synthetic);
    assert_eq!(moved.recipe.segments, view.recipe.segments);
    assert_eq!(
        moved
            .messages
            .iter()
            .map(|(l, m)| (l.clone(), m.mid.clone(), m.message_bytes.clone()))
            .collect::<Vec<_>>(),
        view.messages
            .iter()
            .map(|(l, m)| (l.clone(), m.mid.clone(), m.message_bytes.clone()))
            .collect::<Vec<_>>()
    );

    // Move inventory version 7 shipped an `mc_provider_views_v1` section just
    // before `mc_provider_legacy_tags_v1`; version 8 has no such section.
    // Rebuild a version-7-shaped stream from the captured sections: the
    // current importer refuses it before reserving or writing anything.
    let bytes = std::fs::read(&staging).unwrap();
    let mut input = std::io::Cursor::new(&bytes);
    let mut sections = Vec::new();
    for table in codec::ship_tables(crate::move_inventory::Store::Module) {
        let start = input.position() as usize;
        let count = codec::read_section(&mut input, table).unwrap();
        for _ in 0..count {
            codec::read_row(&mut input, table).unwrap();
        }
        sections.push((
            table.table,
            bytes[start..input.position() as usize].to_vec(),
        ));
    }
    let at = sections
        .iter()
        .position(|(table, _)| *table == "mc_provider_legacy_tags_v1")
        .unwrap();
    let mut retired = Vec::new();
    let named = |out: &mut Vec<u8>, text: &str| {
        codec::write_count(out, text.len() as u64).unwrap();
        out.extend_from_slice(text.as_bytes());
    };
    named(&mut retired, "mc_provider_views_v1");
    let columns = [
        "conv_key",
        "version",
        "lineage_id",
        "range_from",
        "range_to",
        "replacement_json",
        "state",
        "view_json",
        "session",
    ];
    codec::write_count(&mut retired, columns.len() as u64).unwrap();
    for column in columns {
        named(&mut retired, column);
    }
    codec::write_count(&mut retired, 0).unwrap();
    sections.insert(at, ("mc_provider_views_v1", retired));
    let old = staging_dir.path().join("inventory-7");
    std::fs::write(
        &old,
        sections
            .iter()
            .flat_map(|(_, bytes)| bytes.clone())
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = open(fresh_dir.path());
    let mut refused = fresh.move_store().unwrap();
    assert_eq!(
        refused
            .reserve_install(&move_binding("old"), "digest", &old)
            .unwrap_err()
            .code(),
        "inventory_mismatch"
    );
    assert!(fresh.load_provider_record(&key).unwrap().is_none());
    // A version-7 receiver reads sections in its own order and expects
    // `mc_provider_views_v1` at the position where this stream has
    // `mc_provider_legacy_tags_v1`, so its strict name check refuses as well.
    let legacy_tags = codec::ship_tables(crate::move_inventory::Store::Module)
        .find(|table| table.table == "mc_provider_legacy_tags_v1")
        .unwrap();
    let mut current = std::io::Cursor::new(&bytes);
    for table in codec::ship_tables(crate::move_inventory::Store::Module) {
        if table.table == legacy_tags.table {
            break;
        }
        let count = codec::read_section(&mut current, table).unwrap();
        for _ in 0..count {
            codec::read_row(&mut current, table).unwrap();
        }
    }
    let mut name = Vec::new();
    let len = codec::read_count(&mut current).unwrap() as usize;
    name.resize(len, 0);
    std::io::Read::read_exact(&mut current, &mut name).unwrap();
    assert_eq!(name, b"mc_provider_legacy_tags_v1");
    assert_ne!(name, b"mc_provider_views_v1");
}
