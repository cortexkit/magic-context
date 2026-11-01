use super::*;
use mc_store::{
    provider_records::{ProviderConversation, ProviderSessionKey},
    ModuleMeta,
};

fn part(ordinal: u64) -> ProviderPolicyPart {
    let id = format!("m-{ordinal}#0");
    ProviderPolicyPart {
        mid: format!("m-{ordinal}"),
        ordinal,
        block_id: id.clone(),
        block_index: 0,
        kind: "text".into(),
        role: "user".into(),
        measurement: TailHygienePartMeasurement {
            key: id,
            content_hash: format!("hash-{ordinal}"),
            kind: TailHygienePartKind::Text,
            tokens: 1000,
            u_tokens: 0,
            tag_number: None,
            tag_status: None,
            protected: false,
            queued_for_drop: false,
        },
        tag_kind: None,
        tag_number: None,
        tag_tokens: 0,
        tool_name: String::new(),
        arc_id: None,
        subject_part: String::new(),
        active: true,
        served: true,
        reduced: false,
        queued: false,
        real_user: true,
        created_at_ms: None,
        completed_at_ms: None,
    }
}

fn insert(sql: &rusqlite::Connection, key: &ProviderSessionKey, part: &ProviderPolicyPart) {
    let mut header = part.clone();
    header.kind = "header".into();
    header.block_id = format!("{}#header", part.mid);
    header.block_index = -1;
    header.measurement.key.clone_from(&header.block_id);
    header.measurement.kind = TailHygienePartKind::Excluded;
    header.measurement.tokens = 0;
    header.measurement.u_tokens = 0;
    sql.execute("INSERT INTO mc_provider_policy_parts_v1(conv_key,lineage_id,ordinal,block_id,policy_json,session) VALUES (?1,'L',?2,?3,?4,'s')",
        rusqlite::params![key.conversation_key(), header.ordinal, header.block_id, serde_json::to_string(&header).unwrap()]).unwrap();
    sql.execute("INSERT INTO mc_provider_policy_parts_v1(conv_key,lineage_id,ordinal,block_id,policy_json,session) VALUES (?1,'L',?2,?3,?4,'s')",
        rusqlite::params![key.conversation_key(), part.ordinal, part.block_id, serde_json::to_string(part).unwrap()]).unwrap();
}

fn rig() -> (
    tempfile::TempDir,
    mc_store::McStore,
    ProviderSessionKey,
    rusqlite::Connection,
    Value,
) {
    let dir = tempfile::tempdir().unwrap();
    let store =
        mc_store::McStore::open_for_test(&crate::test_support::descriptor(dir.path())).unwrap();
    let key = ProviderSessionKey {
        project_root: "/fixture".into(),
        session: "s".into(),
        harness: "opencode".into(),
        generation: None,
    };
    let parts = (0..3).map(part).collect::<Vec<_>>();
    let inputs = transform::channel1_inputs_from_parts(
        &parts,
        &Value::Null,
        0,
        &BTreeMap::new(),
        false,
        false,
        None,
    );
    let settings = transform::provider_engine_settings(&ModuleMeta {
        tail_hygiene_baseline: Some(inputs.baseline),
        ..Default::default()
    });
    store
        .save_provider_conversation(
            &key,
            &ProviderConversation {
                lineage_id: "L".into(),
                engine_namespace: "engine".into(),
                hook_counters_json: serde_json::json!({"engine_policy":settings}).to_string(),
                ..Default::default()
            },
        )
        .unwrap();
    let sql = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
    sql.execute(
        "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'L',0,NULL,NULL,'s')",
        [key.conversation_key()],
    )
    .unwrap();
    for p in parts {
        insert(&sql, &key, &p);
    }
    let (_, summary) = store
        .read_provider_resident_policy(&key, |index, _| {
            channel1_inputs(index, &settings, 0, &BTreeMap::new(), false, false, None)
        })
        .unwrap();
    sql.execute("INSERT INTO mc_provider_policy_summaries_v1(conv_key,summary_json,session) VALUES (?1,?2,'s')", rusqlite::params![key.conversation_key(), summary.unwrap()]).unwrap();
    (dir, store, key, sql, settings)
}

#[test]
fn resident_delta_inputs_equal_full_policy_oracle() {
    let (_dir, store, key, sql, settings) = rig();
    let mut rebuilt = store
        .read_provider_resident_policy(&key, |index, counters| {
            ResidentPolicy::rebuild(index, counters, 0, &BTreeMap::new())
        })
        .unwrap();
    insert(&sql, &key, &part(3));
    let actual = store
        .read_provider_resident_policy(&key, |index, _| {
            resident_channel1_inputs(
                &mut rebuilt,
                index,
                &settings,
                0,
                &BTreeMap::new(),
                false,
                false,
                None,
            )
        })
        .unwrap()
        .0;
    let mut expected = transform::channel1_inputs_from_parts(
        &(0..4).map(part).collect::<Vec<_>>(),
        &settings,
        0,
        &BTreeMap::new(),
        false,
        false,
        None,
    );
    expected.baseline.baseline_parts.clear();
    assert_eq!(actual.users, 4);
    assert_eq!(
        serde_json::to_value(actual.baseline).unwrap(),
        serde_json::to_value(expected.baseline).unwrap()
    );
    assert_eq!(actual.hint, expected.hint);
    assert_eq!(
        rebuilt.replays, 1,
        "the test must reach delta replay, not full fallback"
    );
}
