use super::*;
use crate::provider_log::{
    ProviderConversation, ProviderLineage, ProviderMessage, ProviderStatusPage,
};
use cortexkit_store_types::{Isolation, StorageBackend};
use serde_json::json;

fn rig() -> (tempfile::TempDir, McStore, ProviderSessionKey) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let key = ProviderSessionKey {
        project_root: "/recipe-fixture".into(),
        session: "s".into(),
        harness: "opencode".into(),
        generation: None,
    };
    seed(&store, &key);
    (dir, store, key)
}

fn seed(store: &McStore, key: &ProviderSessionKey) {
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
    store.commit_provider_status_page(key,ProviderStatusPage {lineage:&ProviderLineage {lineage_id:"L".into(),first_ordinal:0,descends_from:None,through_ordinal:None},messages:&[ProviderMessage {ordinal:0,mid:"m".into(),message_bytes:br#"{"info":{"id":"m","role":"user"},"parts":[{"type":"text","text":"immutable native text"}]}"#.to_vec()}],served:Some(0),unserved:&[],newest:Some(0),more:false}).unwrap();
}

fn recipe(version: u64, base: Option<u64>) -> ProviderViewRecipe {
    ProviderViewRecipe {
        version,
        lineage_id: "L".into(),
        range_from: 0,
        range_to: 1,
        base_version: base,
        policy_cut_id: None,
        metadata: json!({"version":version}),
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
        synthetic: if version == 1 {
            std::collections::BTreeMap::from([(
                "head".into(),
                json!({"text":"only genuinely new synthetic bytes"}),
            )])
        } else {
            Default::default()
        },
        treatments: vec![],
        serializer_profile: "opencode-aisdk".into(),
        render_key: "fixture-render-v1".into(),
        tokenizer_key: "fixture-tokenizer-v1".into(),
        state: "applied".into(),
    }
}

#[test]
fn v2_inheritance_reroots_at_sixteen_and_keeps_native_source_identity() {
    let (_dir, store, key) = rig();
    for version in 1..=50 {
        store
            .save_provider_view_recipe(&key, &recipe(version, (version > 1).then_some(version - 1)))
            .unwrap();
        let value = store.resolve_provider_view(&key, version).unwrap().unwrap();
        assert!(
            value.depth <= 16,
            "reconstruction must respect the fixed external depth contract"
        );
        assert_eq!(value.messages.len(), 1);
        assert_eq!(
            value.recipe.synthetic["head"]["text"],
            "only genuinely new synthetic bytes"
        );
        store
            .prune_provider_view_recipes(&key, &std::collections::BTreeSet::from([version]))
            .unwrap();
    }
    let rows = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_provider_views_v2 WHERE conv_key=?1",
                [key.conversation_key()],
                |r| r.get::<_, u64>(0),
            )
        })
        .unwrap();
    assert!(rows <= 17);
}

#[test]
fn v2_pruning_keeps_every_applied_produced_lkg_and_receipt_root() {
    let (_dir, store, key) = rig();
    for version in 1..=5 {
        let mut r = recipe(version, None);
        r.synthetic = recipe(1, None).synthetic;
        store.save_provider_view_recipe(&key, &r).unwrap();
    }
    let roots = std::collections::BTreeSet::from([1, 3, 5]);
    assert_eq!(store.prune_provider_view_recipes(&key, &roots).unwrap(), 2);
    for version in roots {
        assert!(store
            .resolve_provider_view(&key, version)
            .unwrap()
            .is_some());
    }
    assert!(store.resolve_provider_view(&key, 2).unwrap().is_none());
    assert!(store.resolve_provider_view(&key, 4).unwrap().is_none());
}

#[test]
fn v2_missing_native_row_never_serves_detached_facts_or_a_stale_view() {
    let (_dir, store, key) = rig();
    store
        .save_provider_view_recipe(&key, &recipe(1, None))
        .unwrap();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "DELETE FROM mc_provider_messages_v1 WHERE conv_key=?1",
                [key.conversation_key()],
            )
            .map(|_| ())
        })
        .unwrap();
    assert!(store.resolve_provider_view(&key, 1).is_err());
}

#[test]
fn v2_message_facts_are_lossless_bounded_and_content_free() {
    let part = part();
    let (blob, bytes) = provider_policy_overlay::encode_facts(std::slice::from_ref(&part)).unwrap();
    let decoded = provider_policy_overlay::decode_facts(&blob, bytes, 1).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), json!([part]));
    assert!(provider_policy_overlay::decode_facts(&blob, bytes - 1, 1).is_err());
    assert!(provider_policy_overlay::decode_facts(&blob, bytes, 2).is_err());
}

fn part() -> provider_log::ProviderPolicyPart {
    provider_log::ProviderPolicyPart {
        mid: "m".into(),
        ordinal: 0,
        block_id: "m#0".into(),
        block_index: 0,
        kind: "text".into(),
        role: "user".into(),
        measurement: TailHygienePartMeasurement {
            key: "m#0".into(),
            content_hash: "original-source-hash".into(),
            kind: TailHygienePartKind::Text,
            tokens: 7,
            u_tokens: 0,
            tag_number: Some(4),
            tag_status: Some("active".into()),
            protected: false,
            queued_for_drop: false,
        },
        tag_kind: Some("text".into()),
        tag_number: Some(4),
        tag_tokens: 7,
        tool_name: String::new(),
        arc_id: None,
        subject_part: String::new(),
        active: true,
        served: true,
        reduced: false,
        queued: false,
        real_user: true,
        created_at_ms: Some(42),
        completed_at_ms: None,
    }
}

#[test]
fn v2_effective_policy_resolves_frozen_facts_defaults_and_point_overrides() {
    let (_dir, store, key) = rig();
    let part = part();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',0,'m#0',?2,'s')",
                params![
                    key.conversation_key(),
                    serde_json::to_string(&part).unwrap()
                ],
            )?;
            let cut = provider_policy_overlay::freeze_cut_tx(
                conn,
                &key.conversation_key(),
                "L",
                Some(0),
                &json!({"baseline":{}}),
                std::slice::from_ref(&part),
            )
            .unwrap();
            conn.execute(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json=?2 WHERE conv_key=?1",
                params![
                    key.conversation_key(),
                    json!({"engine_policy":{"baseline_cut_id":cut}}).to_string()
                ],
            )?;
            conn.execute(
                "INSERT INTO mc_provider_policy_overrides_v1 VALUES(?1,'L','m#0',0,?2,?3,'s')",
                params![
                    key.conversation_key(),
                    cut,
                    json!({"queued":true,"measurement":{"tokens":13,"queued_for_drop":true}})
                        .to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    let physical: u64 = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_provider_policy_parts_v1 WHERE conv_key=?1",
                [key.conversation_key()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        physical, 0,
        "only live-tail rows remain physical policy rows"
    );
    let effective = store
        .read_provider_resident_policy(&key, |index, _| index.all_parts())
        .unwrap();
    assert_eq!(effective.len(), 1);
    assert_eq!(
        effective[0].measurement.content_hash,
        "original-source-hash"
    );
    assert_eq!(effective[0].measurement.tokens, 13);
    assert!(effective[0].queued && effective[0].measurement.queued_for_drop);
}

#[test]
fn v2_session_deletion_removes_recipe_dependencies_and_keeps_other_sessions() {
    let (_dir, store, key) = rig();
    let mut other = key.clone();
    other.session = "other".into();
    seed(&store, &other);
    for session in [&key, &other] {
        let namespace = format!("engine-{}", session.session);
        store
            .commit(
                &namespace,
                None,
                &cortexkit_cache_core::CoreState::default(),
                &ModuleMeta {
                    initialized: true,
                    ..Default::default()
                },
            )
            .unwrap();
        store.inner.with_conn_fenced(|conn| {
            let cut = provider_policy_overlay::freeze_cut_tx(
                conn, &session.conversation_key(), "L", Some(0),
                &json!({"baseline":{}}), &[part()],
            ).unwrap();
            conn.execute("UPDATE mc_provider_conversations_v2 SET hook_counters_json=?2 WHERE conv_key=?1", params![session.conversation_key(),json!({"engine_policy":{"baseline_cut_id":cut}}).to_string()])?;
            conn.execute("INSERT INTO mc_provider_policy_overrides_v1 VALUES(?1,'L','m#0',0,?2,'{}',?3)", params![session.conversation_key(),cut,session.session])?;
            Ok(())
        }).unwrap();
        for version in 1..=2 {
            let mut view = recipe(version, (version > 1).then_some(version - 1));
            view.policy_cut_id = Some(0);
            view.treatments = vec![ProviderViewTreatment {
                source_lineage_id: "L".into(),
                mid: "m".into(),
                ordinal: 0,
                block_index: 0,
                block_id: "m#0".into(),
                patch: Some(json!({"wire":{}})),
            }];
            store.save_provider_view_recipe(session, &view).unwrap();
        }
    }
    assert!(
        store
            .delete_session(&key.session, &key.project_root)
            .unwrap()
            > 0
    );
    store.inner.with_conn(|conn| {
        for table in ["mc_provider_view_overrides_v1", "mc_provider_views_v2",
            "mc_provider_policy_overrides_v1", "mc_provider_policy_cuts_v1",
            "mc_provider_messages_v1", "mc_provider_lineages_v1", "mc_provider_conversations_v2"] {
            let counts: (u64,u64) = conn.query_row(
                &format!("SELECT count(*) FILTER(WHERE session=?1),count(*) FILTER(WHERE session=?2) FROM {table}"),
                params![key.session,other.session], |row| Ok((row.get(0)?,row.get(1)?)),
            )?;
            assert_eq!(counts.0, 0, "target session survives in {table}");
            assert!(counts.1 > 0, "other session was removed from {table}");
        }
        Ok(())
    }).unwrap();
    assert!(!store.load("engine-s").unwrap().meta.initialized);
    assert!(store.load("engine-other").unwrap().meta.initialized);
    assert_eq!(
        store
            .delete_session(&key.session, &key.project_root)
            .unwrap(),
        0
    );
    assert!(store.resolve_provider_view(&other, 2).unwrap().is_some());
}

#[test]
fn v2_rebuild_caps_include_frozen_source_facts_before_decoding() {
    let (_dir, store, key) = rig();
    store
        .inner
        .with_conn_fenced(|conn| {
            provider_policy_overlay::freeze_cut_tx(
                conn,
                &key.conversation_key(),
                "L",
                Some(0),
                &json!({}),
                &[part()],
            )
            .unwrap();
            conn.execute(
                "UPDATE mc_provider_messages_v1 SET frozen_policy_parts=100001 WHERE conv_key=?1",
                [key.conversation_key()],
            )?;
            Ok(())
        })
        .unwrap();
    let result: Result<(), _> = store.read_provider_resident_policy(&key, |_, _| {
        panic!("oversize input must be refused before the rebuild callback");
    });
    assert!(
        matches!(result, Err(provider_log::ProviderError::Transient(message))
        if message.starts_with("resident_not_ready:") && message.contains("cap"))
    );
}

fn cache_policy_commit(
    store: &McStore,
    namespace: &str,
    meta: &ModuleMeta,
    policy: &provider_log::ProviderEnginePolicy,
) -> Result<u64, McStoreError> {
    let state = store.load(namespace)?;
    store.commit_transform_with_provider_policy(
        namespace,
        TransformCommit {
            expected: state.row_version,
            core: &state.core,
            meta,
            sections: SectionsCommit::over(state.sections.as_ref()),
            consumed_drop_ids: &[],
            first_applied_command_ids: &[],
            memory_revision: None,
            compartment_max_seq: None,
            project_root: None,
            first_divergence: None,
            scheduler_observation: None,
            scheduler_request_observed_at_ms: None,
            scheduler_full_array_fingerprint: None,
            scheduler_eligible_supersession_count: None,
            scheduler_withheld_by_tag_window: None,
            scheduler_withheld_by_exempt_message: None,
            scheduler_applied_supersession_count: None,
            scheduler_applied_reductions: false,
            overlays: TransformOverlayBatch::default(),
        },
        Some(policy),
    )
}

fn native_cache_inputs() -> (ModuleMeta, provider_log::ProviderEnginePolicy) {
    let mut part = part();
    part.measurement.kind = TailHygienePartKind::Excluded;
    part.measurement.tokens = 0;
    part.measurement.tag_number = None;
    part.measurement.tag_status = None;
    let meta = ModuleMeta {
        initialized: true,
        coverage_ordinal: Some(0),
        tail_hygiene_baseline: Some(TailHygieneBaseline {
            baseline_t: 17,
            baseline_u: 7,
            baseline_generation: 2,
            content_signature: "signature-of-complete-old-baseline".into(),
            baseline_parts: vec![part.measurement.clone()],
            ..Default::default()
        }),
        ..Default::default()
    };
    let policy = provider_log::ProviderEnginePolicy {
        native_prefix: None,
        parts: vec![part],
        settings: json!({"coverage":0,"baseline":{}}),
        native_tail_section: true,
    };
    (meta, policy)
}

#[test]
fn native_tail_cache_round_trip_and_meta_only_writes_preserve_effective_baseline() {
    let (_dir, store, key) = rig();
    let namespace = "engine-s";
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&store, namespace, &meta, &policy).unwrap();
    let loaded = store.load(namespace).unwrap();
    assert_eq!(loaded.meta, meta);
    let (small, tail): (String,String) = store.inner.with_conn(|conn| {
        Ok((conn.query_row("SELECT meta FROM mc_cache_state WHERE session_id=?1",[namespace],|row|row.get(0))?,
            conn.query_row("SELECT body FROM mc_cache_sections WHERE session_id=?1 AND section='tail_hygiene_baseline'",[namespace],|row|row.get(0))?))
    }).unwrap();
    assert!(small.contains("mc_native_tail_v1"));
    let body: Value = serde_json::from_str(&tail).unwrap();
    assert_eq!(body["baseline"]["baseline_parts"], json!([]));
    assert_eq!(body["reference"]["prefix_count"], json!(1));
    // The v72 decoder rejected either moved key before deserializing ModuleMeta.
    // This independent copy does not call the new marker-aware decoder.
    let old = |raw: &str| -> Result<ModuleMeta, &'static str> {
        let object: Value = serde_json::from_str(raw).unwrap();
        if object.get("resolved_compartment_boundaries").is_some() {
            return Err("resolved_compartment_boundaries");
        }
        if object.get("tail_hygiene_baseline").is_some() {
            return Err("tail_hygiene_baseline");
        }
        Ok(serde_json::from_str(raw).unwrap())
    };
    assert_eq!(old(&small), Err("tail_hygiene_baseline"));
    let mut scalars = store.load_meta(namespace).unwrap();
    assert!(scalars.meta.tail_hygiene_baseline.is_none());
    scalars.meta.soft_refresh_pending = true;
    store
        .commit_meta(namespace, scalars.row_version, &scalars.meta)
        .unwrap();
    assert_eq!(
        store.load(namespace).unwrap().meta.tail_hygiene_baseline,
        meta.tail_hygiene_baseline
    );
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "DELETE FROM mc_provider_messages_v1 WHERE conv_key=?1",
                [key.conversation_key()],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(
        store.load(namespace).is_err(),
        "retired facts must not fabricate an old baseline"
    );
}

#[test]
fn native_tail_failed_section_commit_rolls_back_cut_and_facts_with_cache() {
    let (_dir, store, key) = rig();
    let namespace = "engine-s";
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&store, namespace, &meta, &policy).unwrap();
    let before = store.load(namespace).unwrap();
    let cuts: u64 = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1",
                [key.conversation_key()],
                |row| row.get(0),
            )
        })
        .unwrap();
    let mut changed = meta.clone();
    changed
        .tail_hygiene_baseline
        .as_mut()
        .unwrap()
        .baseline_generation += 1;
    cache_codec::fail_next_commit_after_section_writes();
    assert!(cache_policy_commit(&store, namespace, &changed, &policy).is_err());
    let after = store.load(namespace).unwrap();
    assert_eq!(after.meta, before.meta);
    assert_eq!(after.row_version, before.row_version);
    assert_eq!(
        store
            .inner
            .with_conn(|conn| conn.query_row(
                "SELECT count(*) FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1",
                [key.conversation_key()],
                |row| row.get::<_, u64>(0)
            ))
            .unwrap(),
        cuts
    );
}

#[test]
fn native_certificate_crosses_frozen_baseline_length_and_validates_its_cut() {
    use cache_codec::NativeSnapshotRejection;
    let (_dir, store, key) = rig();
    let namespace = "engine-s";
    let mut prefix = provider_log::ProviderNativePrefix {
        cut_id: 0,
        through: 0,
        parts: 1,
    };
    assert!(matches!(
        store.load_native_transform_snapshot(namespace, &prefix, &[]),
        Err(McStoreError::NativeSnapshotUnavailable(
            NativeSnapshotRejection::MissingReference
        ))
    ));
    let (mut meta, policy) = native_cache_inputs();
    let measurement = meta
        .tail_hygiene_baseline
        .as_mut()
        .unwrap()
        .baseline_parts
        .pop()
        .unwrap();
    cache_policy_commit(&store, namespace, &meta, &policy).unwrap();
    assert!(matches!(
        store.load_native_transform_snapshot(namespace, &prefix, &[]),
        Err(McStoreError::NativeSnapshotUnavailable(
            NativeSnapshotRejection::MissingReference
        ))
    ));
    assert_eq!(
        store.load(namespace).unwrap().meta.tail_hygiene_baseline,
        meta.tail_hygiene_baseline
    );

    meta.tail_hygiene_baseline
        .as_mut()
        .unwrap()
        .baseline_parts
        .push(measurement);
    cache_policy_commit(&store, namespace, &meta, &policy).unwrap();
    prefix.cut_id = store.provider_fold_settings(&key).unwrap()["baseline_cut_id"]
        .as_u64()
        .unwrap();
    let native = store
        .load_native_transform_snapshot(namespace, &prefix, &[])
        .unwrap();
    assert!(native
        .loaded
        .meta
        .tail_hygiene_baseline
        .unwrap()
        .baseline_parts
        .is_empty());
    prefix.parts += 1;
    assert!(matches!(
        store.load_native_transform_snapshot(namespace, &prefix, &[]),
        Err(McStoreError::NativeSnapshotUnavailable(
            NativeSnapshotRejection::ReferenceMismatch
        ))
    ));
    prefix.parts -= 1;
    prefix.through += 1;
    assert!(matches!(
        store.load_native_transform_snapshot(namespace, &prefix, &[]),
        Err(McStoreError::NativeSnapshotUnavailable(
            NativeSnapshotRejection::CoverageMismatch
        ))
    ));
    assert_eq!(
        store.native_snapshot_fallback_for_test(namespace),
        Some(NativeSnapshotRejection::MissingReference)
    );
    prefix.through -= 1;
    prefix.parts += 1;
    store
        .inner
        .with_conn(|conn| {
            let raw: String = conn.query_row(
                "SELECT meta FROM mc_cache_state WHERE session_id=?1",
                [namespace],
                |row| row.get(0),
            )?;
            let mut meta: Value = serde_json::from_str(&raw).unwrap();
            meta["tail_hygiene_baseline"]["prefix_count"] = json!(prefix.parts);
            conn.execute(
                "UPDATE mc_cache_state SET meta=?2 WHERE session_id=?1",
                params![namespace, meta.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    assert!(
        matches!(
            store.load_native_transform_snapshot(namespace, &prefix, &[]),
            Err(McStoreError::NativeSnapshotUnavailable(
                NativeSnapshotRejection::ReferenceMismatch
            ))
        ),
        "the small-row certificate must match the hashed section's certificate"
    );
}

#[test]
fn native_tail_control_does_not_change_generic_namespace_section_bytes() {
    let (_dir, store, key) = rig();
    let generic = ProviderSessionKey {
        harness: "broca".into(),
        ..key
    };
    seed(&store, &generic);
    // Shared ownership is not a native-only namespace even if one caller sets
    // the internal control. Neither generic nor shadow state may be converted.
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&store, "engine-s", &meta, &policy).unwrap();
    let raw: (String,String) = store.inner.with_conn(|conn| Ok((
        conn.query_row("SELECT meta FROM mc_cache_state WHERE session_id='engine-s'",[],|row|row.get(0))?,
        conn.query_row("SELECT body FROM mc_cache_sections WHERE session_id='engine-s' AND section='tail_hygiene_baseline'",[],|row|row.get(0))?,
    ))).unwrap();
    assert!(!raw.0.contains("mc_native_tail_v1"));
    assert_eq!(
        raw.1,
        serde_json::to_string(meta.tail_hygiene_baseline.as_ref().unwrap()).unwrap()
    );
}

#[test]
fn native_tail_cut_survives_view_pruning_while_cache_still_references_it() {
    let (_dir, store, key) = rig();
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&store, "engine-s", &meta, &policy).unwrap();
    store
        .save_provider_view_recipe(&key, &recipe(1, None))
        .unwrap();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json='{}' WHERE conv_key=?1",
                [key.conversation_key()],
            )?;
            Ok(())
        })
        .unwrap();
    store
        .prune_provider_view_recipes(&key, &std::collections::BTreeSet::from([1]))
        .unwrap();
    assert_eq!(
        store.load("engine-s").unwrap().meta.tail_hygiene_baseline,
        meta.tail_hygiene_baseline
    );
}

fn native_move_descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    }
}
fn native_move_rows(conn: &rusqlite::Connection, table: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut query = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
        .unwrap();
    let columns = query.column_count();
    query
        .query_map([], |row| {
            (0..columns)
                .map(|i| row.get(i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn review_native_fact_agent_move_round_trip_preserves_cache_policy_and_recipe() {
    let (_source_dir, source, key) = rig();
    let mut conversation = source.load_provider_conversation(&key).unwrap().unwrap();
    conversation.engine_namespace = key.session.clone();
    source
        .save_provider_conversation(&key, &conversation)
        .unwrap();
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&source, &key.session, &meta, &policy).unwrap();
    source
        .save_provider_view_recipe(&key, &recipe(1, None))
        .unwrap();
    let expected_policy = source
        .read_provider_resident_policy(&key, |index, _| index.all_parts())
        .unwrap();
    let expected_view = source.resolve_provider_view(&key, 1).unwrap().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let staging = destination.path().join("staging");
    let binding = crate::move_store::CutBinding {
        cut_id: "review-cut".into(),
        session_ref: "0123456789abcdef".into(),
        host_session_id: key.session.clone(),
        host_end_offset: 42,
        host_cut: json!({"review":"native-facts"}),
        mc_start_offset: 100,
    };
    let mut export = source.move_store().unwrap();
    export.acquire_fence(&binding).unwrap();
    export.freeze(&binding.cut_id).unwrap();
    export.capture(&binding.cut_id, &staging).unwrap();
    let source_revision = source.provider_policy_revision(&key.session).unwrap();
    let target = McStore::open_for_test(&native_move_descriptor(destination.path())).unwrap();
    let mut import = target.move_store().unwrap();
    import
        .reserve_install(&binding, "review-digest", &staging)
        .unwrap();
    while !import.install_batch(&binding.cut_id).unwrap().complete {}
    import
        .finish_install(&binding.cut_id, "review-result")
        .unwrap();
    import.activate_for_test(&binding.cut_id).unwrap();
    assert!(
        target.provider_policy_revision(&key.session).unwrap() > source_revision,
        "destination revision must advance past the source fence"
    );
    assert_eq!(
        target
            .load(&key.session)
            .unwrap()
            .meta
            .tail_hygiene_baseline,
        meta.tail_hygiene_baseline
    );
    assert_eq!(
        json!(target
            .read_provider_resident_policy(&key, |index, _| index.all_parts())
            .unwrap()),
        json!(expected_policy)
    );
    let view = target.resolve_provider_view(&key, 1).unwrap().unwrap();
    let message_values = |messages: &Vec<(String, ProviderMessage)>| {
        messages
            .iter()
            .map(|(lineage, message)| {
                json!([lineage, message.ordinal, message.mid, message.message_bytes])
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        message_values(&view.messages),
        message_values(&expected_view.messages)
    );
    assert_eq!(view.recipe.segments, expected_view.recipe.segments);
    assert_eq!(view.recipe.metadata, expected_view.recipe.metadata);
    assert_eq!(view.recipe.synthetic, expected_view.recipe.synthetic);
    assert_eq!(view.recipe.treatments, expected_view.recipe.treatments);
    for table in [
        "mc_provider_messages_v1",
        "mc_provider_policy_cuts_v1",
        "mc_provider_views_v2",
        "mc_cache_state",
        "mc_cache_sections",
    ] {
        let from = source
            .inner
            .with_conn(|conn| Ok(native_move_rows(conn, table)))
            .unwrap();
        let to = target
            .inner
            .with_conn(|conn| Ok(native_move_rows(conn, table)))
            .unwrap();
        assert!(!from.is_empty(), "{table} must actually be populated");
        assert_eq!(to, from, "{table}");
    }
}

#[test]
fn native_move_foreign_revision_collisions_refuse_before_install_and_after_reservation() {
    for race in [false, true] {
        let (_source_dir, source, key) = rig();
        let mut conversation = source.load_provider_conversation(&key).unwrap().unwrap();
        conversation.engine_namespace = key.session.clone();
        source
            .save_provider_conversation(&key, &conversation)
            .unwrap();
        let (meta, policy) = native_cache_inputs();
        cache_policy_commit(&source, &key.session, &meta, &policy).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join("snapshot");
        let binding = crate::move_store::CutBinding {
            cut_id: "foreign-revision-cut".into(),
            session_ref: "0123456789abcdef".into(),
            host_session_id: key.session.clone(),
            host_end_offset: 42,
            host_cut: json!({}),
            mc_start_offset: 100,
        };
        let mut export = source.move_store().unwrap();
        export.acquire_fence(&binding).unwrap();
        export.freeze(&binding.cut_id).unwrap();
        export.capture(&binding.cut_id, &staging).unwrap();
        let target = McStore::open_for_test(&native_move_descriptor(directory.path())).unwrap();
        let mut import = target.move_store().unwrap();
        if race {
            import
                .reserve_install(&binding, "digest", &staging)
                .unwrap();
        }
        target
            .inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "INSERT INTO mc_provider_policy_revisions_v1 VALUES(?1,9001,'foreign-session')",
                    [&key.session],
                )?;
                Ok(())
            })
            .unwrap();
        let before = target
            .inner
            .with_conn(|conn| Ok(native_move_rows(conn, "mc_provider_policy_revisions_v1")))
            .unwrap();
        let result = if race {
            import.install_batch(&binding.cut_id).map(|_| ())
        } else {
            import.reserve_install(&binding, "digest", &staging)
        };
        assert!(
            matches!(result, Err(crate::move_store::MoveError::Refused { code:"key_collision",table:Some(ref table) })
            if table=="mc_provider_policy_revisions_v1"),
            "foreign revision must not be merged (race={race}): {result:?}"
        );
        assert_eq!(
            target
                .inner
                .with_conn(|conn| Ok(native_move_rows(conn, "mc_provider_policy_revisions_v1")))
                .unwrap(),
            before
        );
        assert!(target.load_provider_conversation(&key).unwrap().is_none());
        assert!(target.load(&key.session).unwrap().row_version.is_none());
        if !race {
            target
                .inner
                .with_conn(|conn| {
                    for table in [
                        "mc_move_cuts",
                        "mc_move_installs",
                        "mc_move_key_map",
                        "mc_move_fences",
                    ] {
                        assert_eq!(
                            conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                                row.get::<_, u64>(0)
                            })?,
                            0
                        );
                    }
                    Ok(())
                })
                .unwrap();
        }
    }
}
