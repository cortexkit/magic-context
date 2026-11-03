use super::*;
use cortexkit_role_compaction::{
    part::Part,
    read::{Entry, Role},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
};
use std::time::Instant;

fn entry(ordinal: u64) -> Entry {
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        if ordinal.is_multiple_of(2) {
            Role::Assistant
        } else {
            Role::User
        },
        ordinal,
        vec![
            Part::new(
                "a",
                PartBody::Text {
                    text: "recorded session text ".repeat(50),
                },
            ),
            Part::new(
                "b",
                PartBody::Text {
                    text: "another message part ".repeat(50),
                },
            ),
        ],
    )
}

#[tokio::test]
#[ignore = "large synthetic session app-read cost measurement"]
async fn app_read_seed_cost() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
    let app = crate::app_read::AppRead::new(Some(store.path.clone()), None);
    let route = Route {
        session: SessionRef::new("runner", "seed", "cost"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        crate::catalog::Preset::Head.as_str(),
        ModelRef::new("test", "model"),
        10_000_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    );
    let mut session = Session::new(
        &route,
        &request,
        crate::preset::features(crate::catalog::Preset::Head.as_str()).unwrap(),
        None,
    );
    session.set_store(Some(store.clone()));
    session.index.extend((1..=9000).map(entry));
    for sequence in 1..=93 {
        session.summaries.push(StoredCompartment {
            sequence,
            start_message: (sequence - 1) * 90 + 1,
            end_message: sequence * 90,
            start_message_id: format!("m{}", (sequence - 1) * 90 + 1),
            end_message_id: format!("m{}", sequence * 90),
            title: format!("Summary {sequence}"),
            content: "summary ".repeat(1000),
            p1: Some("detail ".repeat(1000)),
            p2: Some("detail ".repeat(500)),
            p3: Some("detail ".repeat(250)),
            p4: Some("detail ".repeat(125)),
            importance: 50,
            created_at: sequence,
            ..Default::default()
        });
    }
    session.app_decisions = (0..256).map(|version| json!({"view_version":version,"status":"accepted","at_ms":version,"cause":"execute","changes":{"model":null,"system_prompt":null,"tool_set":null},"dropped_tokens":100,"materialized":false})).collect();
    session.app_decisions_revision += 1;
    session.app_decisions_dirty = true;
    session.publish_app(&app, true);
    app.read(
        "session_data.read",
        json!({"session":route.session,"section":"meta"}),
    )
    .await
    .unwrap();
    let setup_write_max_us = store.take_write_max_ns() / 1000;
    store.take_app_writes();
    let mut times = Vec::new();
    for ordinal in 9001..=9030 {
        let next=entry(ordinal);
        let started = Instant::now();
        session.index.extend([next]);
        session.conditions.last_prompt_tokens = Some(ordinal * 100);
        session.publish_app(&app, false);
        assert_eq!(session.app_projection.rebuilt_rows, 1);
        store.save(session.key(), &session.durable()).unwrap();
        times.push(started.elapsed().as_nanos() as u64);
    }
    app.read(
        "session_data.read",
        json!({"session":route.session,"section":"meta"}),
    )
    .await
    .unwrap();
    times.sort_unstable();
    let writes = store.take_app_writes();
    let mean=times.iter().sum::<u64>()/times.len() as u64;
    assert!(mean < 5_000_000,"mean app-read notice cost must stay below 5 ms");
    assert_eq!(
        writes,
        (30, 0, 0),
        "ordinary notices append one identity each, without checkpoints or decision writes"
    );
    println!("APP_READ_COST messages=9000 summaries=93 notices=30 mean_us={} p95_us={} max_us={} mode3_write_max_us={} setup_write_max_us={} index_rows={} snapshot_writes={} decision_writes={}", times.iter().sum::<u64>()/times.len() as u64/1000, times[28]/1000, times[29]/1000, store.take_write_max_ns()/1000,setup_write_max_us,writes.0,writes.1,writes.2);
}
