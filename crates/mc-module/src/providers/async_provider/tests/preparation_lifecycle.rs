use super::*;
use crate::providers::async_provider::offline_first_pass::{
    adopted, OfflineFirstPass, PreparationState, MARKER_VERSION,
};

fn marker(request: &Value) -> OfflineFirstPass {
    OfflineFirstPass {
        version: MARKER_VERSION,
        state: PreparationState::Preparing,
        bound_generation: None,
        setup: crate::providers::async_provider::offline_first_pass::setup_identity_digest(
            &decode(request).unwrap(),
            MODULE,
        )
        .unwrap(),
        describe: Some(
            crate::providers::async_provider::offline_first_pass::runner_describe_digest(
                &runner_describe(),
            )
            .unwrap(),
        ),
        inputs: None,
        proof: None,
    }
}

// Independent runner-side application: this deliberately does not call the
// provider's retained-row renderer, so a missed drop cannot bless itself.
fn apply_view(view: &view::CompactionView, entries: &[ReadMessage]) -> Vec<Value> {
    let mut output = Vec::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                output.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
            }
            view::ViewRange::Keep { from, to, edits } => {
                for entry in entries
                    .iter()
                    .filter(|entry| *from <= entry.ordinal && entry.ordinal < *to)
                {
                    let entry = serve_descriptors(entry);
                    let mut message = entry.message.clone();
                    let mut rendered = Vec::new();
                    for (part, tag) in parts(&entry.message).unwrap().iter().zip(&entry.tags) {
                        match edits
                            .iter()
                            .find(|edit| edit.ordinal == entry.ordinal && edit.part == tag.part)
                        {
                            Some(edit) if edit.drop => {}
                            Some(edit) => rendered
                                .push(serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap()),
                            None => {
                                let mut part = part.clone();
                                if let Some(tag) = &tag.tag {
                                    let pointer = if part["type"] == "tool" {
                                        "/state/output"
                                    } else {
                                        "/text"
                                    };
                                    let text = part.pointer_mut(pointer).unwrap();
                                    *text = json!(format!("{tag} {}", text.as_str().unwrap()));
                                }
                                rendered.push(part);
                            }
                        }
                    }
                    message["parts"] = json!(rendered);
                    output.push(message);
                }
            }
            _ => panic!("unknown view range"),
        }
    }
    output.extend(
        entries
            .iter()
            .filter(|entry| entry.ordinal > view.covers_through.ordinal)
            .map(|entry| entry.message.clone()),
    );
    output
}

#[derive(Default)]
struct ModelRecorder {
    requests: Vec<Vec<Value>>,
    prefix: Option<Value>,
    rebuilds: usize,
}

impl ModelRecorder {
    fn setup(&mut self, answer: &Value, entries: &[ReadMessage]) -> Vec<Value> {
        let mut request: Vec<Value> = decode(&answer["initial"]["replacement"]).unwrap();
        let to = answer["initial"]["range"]["to"].as_u64().unwrap();
        request.extend(
            entries
                .iter()
                .filter(|entry| entry.ordinal >= to)
                .map(|entry| entry.message.clone()),
        );
        self.rebuilds += usize::from(self.prefix.as_ref() != Some(&answer["initial"]));
        self.prefix = Some(answer["initial"].clone());
        self.requests.push(request.clone());
        request
    }
}

#[tokio::test]
async fn offline_setup_saves_preparing_with_only_the_head_insertion() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (paths, session, served) = moved_stores(store.path(), fixture_stores);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &session,
        Served::new(served, 7),
        config(),
    );
    let request = setup_request(&session, "fixture");
    let binding = SessionBinding {
        principal: Some(subc_protocol::Principal::Reserved {
            module_id: MODULE.into(),
        }),
        scope: None,
        project_root: project.path().into(),
        harness: "runner".into(),
        session: session.clone(),
        model_key: None,
        config: config(),
        history_budget_tokens: 4_000.0,
    };
    let answer: Value = serde_json::from_slice(
        &arm.h
            .async_setup_inner(CHANNEL, &binding, &request, Some(marker(&request)))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(answer["answer"], "ready", "{answer}");
    let origin = arm.runner.entries.lock().unwrap()[0].ordinal;
    assert_eq!(
        answer["initial"]["range"],
        json!({"from":origin,"to":origin})
    );
    let state = arm.state();
    assert!(state.entries.is_empty());
    assert_eq!(
        state.offline_first_pass.unwrap().state,
        PreparationState::Preparing
    );
    let before = store_rows(&paths);
    assert_eq!(arm.setup(request).await["code"], "moved_session_unprepared");
    assert!(arm
        .notice(1, 0, None, Vec::new())
        .await
        .contains("moved_session_unprepared"));
    assert_eq!(store_rows(&paths), before);
    assert!(arm.runner.sends.lock().unwrap().is_empty());
    assert!(arm.views().is_empty());
}

#[tokio::test]
async fn first_live_adoption_refuses_missing_preparing_and_importing_without_writes() {
    let _clock = crate::tests::fixed_clock();
    for stage in ["missing", "preparing", "importing"] {
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
        rewrite_offline_marker(&prep, |marker| {
            if stage == "missing" {
                *marker = Value::Null;
            } else {
                marker["state"] = json!("preparing");
            }
        });
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            Served::new(prep.served.clone(), 7),
            config(),
        );
        if stage == "importing" {
            let mut state = arm.state();
            state.standalone_move.as_mut().unwrap().pending = Some(
                offline_move::read_move_record(
                    &rusqlite::Connection::open(&prep.paths.context_db).unwrap(),
                    &prep.session,
                )
                .unwrap()
                .unwrap()
                .unwrap(),
            );
            state.initial = Value::Null;
            state.save(arm.store(), &[]).unwrap();
            assert!(arm.state().is_importing_stage());
        }
        let before = store_rows(&prep.paths);
        assert_eq!(
            arm.setup(setup_request(&prep.session, "fixture")).await["code"],
            "moved_session_unprepared",
            "{stage}"
        );
        assert!(
            arm.notice(1, 0, None, Vec::new())
                .await
                .contains("moved_session_unprepared"),
            "{stage}"
        );
        assert_eq!(store_rows(&prep.paths), before, "{stage}");
        assert!(arm.runner.sends.lock().unwrap().is_empty());
        assert!(arm.announced.0.lock().unwrap().is_empty());
        assert!(arm.runner.read_from.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_recordless_moved_notice_is_a_noop_and_setup_refuses_unprepared() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (paths, session, served) = moved_stores(store.path(), fixture_stores);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &session,
        Served::new(served, 7),
        config(),
    );
    let before = store_rows(&paths);
    let passes = resident::counters::read().engine_passes;
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    assert!(arm.runner.read_from.lock().unwrap().is_empty());
    assert_eq!(resident::counters::read().engine_passes, passes);
    assert!(arm.views().is_empty());
    assert!(arm.runner.sends.lock().unwrap().is_empty());
    assert_eq!(store_rows(&paths), before);
    assert!(load_head(arm.store(), &arm.reference()).unwrap().is_none());
    assert_eq!(
        arm.setup(setup_request(&session, "fixture")).await["code"],
        "moved_session_unprepared"
    );
    assert_eq!(store_rows(&paths), before);
}

#[tokio::test]
async fn a_non_moved_notice_still_runs_the_ordinary_first_pass() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(4);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.state().completed_seq, 1);
    assert_eq!(rig.state().entries.len(), 4);
    assert!(rig.state().offline_first_pass.is_none());
}

#[tokio::test]
async fn prepared_setup_and_notice_first_keep_the_exact_view_and_append_horizon() {
    let _clock = crate::tests::fixed_clock();
    for notice_first in [false, true] {
        let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (prep, outcome) = prepared(store.path(), project.path(), fixture_stores).await;
        let OfflineOutcome::Prepared(report) = outcome else {
            panic!("{outcome:?}")
        };
        let runner = Served::new(prep.served.clone(), 7);
        let mut arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            runner,
            config(),
        );
        let state = arm.state();
        assert_eq!(
            state.offline_first_pass.as_ref().unwrap().state,
            PreparationState::Prepared
        );
        let moved = offline_move::read_move_record(
            &rusqlite::Connection::open(&prep.paths.context_db).unwrap(),
            &prep.session,
        )
        .unwrap()
        .unwrap()
        .unwrap();
        let bound = &state.standalone_move.as_ref().unwrap().bound_drops;
        assert_eq!(bound.len(), moved.drops.len());
        for drop in &moved.drops {
            assert!(bound.iter().any(|binding| binding.mid == drop.mid
                && binding.part == drop.part
                && binding.kind == drop.kind));
        }
        let view: view::CompactionView = serde_json::from_str(&arm.views()[0].1).unwrap();
        let expected = apply_view(&view, &prep.served);
        assert_eq!(state.initial["initial"]["replacement"], json!(expected));
        for drop in moved
            .drops
            .iter()
            .filter(|drop| drop.kind == offline_move::DropKind::Applied)
        {
            assert!(
                expected
                    .iter()
                    .flat_map(|message| message["parts"].as_array().into_iter().flatten())
                    .all(|part| part["id"].as_str() != Some(drop.part.as_str())),
                "prepared request retained applied drop {}:{}",
                drop.mid,
                drop.part
            );
        }
        let stored = state.initial["initial"].clone();
        let mut model = ModelRecorder::default();
        if notice_first {
            assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
            assert!(adopted(&arm.state()));
        }
        // New rows are not included in the stored prepared horizon, even if
        // Setup is the first live operation to observe their existence.
        let appended = appended(
            &prep.session,
            report.proof.end,
            highest_tag(&prep.served) + 1,
        );
        arm.runner.entries.lock().unwrap().push(appended.clone());
        arm.runner.read_from.lock().unwrap().clear();
        for _ in 0..2 {
            let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
            assert_eq!(answer["answer"], "ready", "{answer}");
            assert_eq!(answer["initial"], stored);
            assert_eq!(
                answer["initial"]["range"],
                json!({"from":report.proof.origin,"to":report.proof.end})
            );
            let mut request = expected.clone();
            request.push(appended.message.clone());
            assert_eq!(
                model.setup(&answer, &arm.runner.entries.lock().unwrap()),
                request
            );
        }
        assert!(
            arm.runner.read_from.lock().unwrap().is_empty(),
            "Setup must not read a suffix"
        );
        assert_eq!(model.requests.len(), 2);
        assert_eq!(model.rebuilds, 1);
        if !notice_first {
            assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
        }
        assert!(adopted(&arm.state()));
        assert_eq!(arm.state().initial["initial"], stored);
        arm.restart();
        assert_eq!(
            arm.setup(setup_request(&prep.session, "fixture")).await["initial"],
            stored
        );
        assert!(adopted(&arm.state()));
    }
}

#[tokio::test]
async fn adopted_survives_restart_recovery_and_native_descent_without_preparation() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let mut arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        config(),
    );
    let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    assert_eq!(arm.notice(2, 0, Some(1), Vec::new()).await, "ok");
    arm.restart();
    assert_eq!(
        arm.setup(setup_request(&prep.session, "fixture")).await["initial"],
        answer["initial"]
    );
    // Adoption is authoritative, not the old preparation certificate. An
    // adopted record no longer consults that certificate at Setup or notice.
    let mut state = arm.state();
    state.offline_first_pass.as_mut().unwrap().version = 0;
    state.save(arm.store(), &[]).unwrap();
    arm.restart();
    *arm.runner.lineage.lock().unwrap() = "recovered".into();
    arm.runner.head.lock().unwrap()["lineage_id"] = json!("recovered");
    let mut request = setup_request(&prep.session, "fixture");
    request["lineage_id"] = json!("recovered");
    let recovered = arm.setup(request.clone()).await;
    assert_eq!(recovered["answer"], "ready", "{recovered}");
    assert!(adopted(&arm.state()));
    assert_eq!(arm.state().generation, 1);
    let namespace = arm.state().namespace();
    let imported: Vec<_> = arm
        .store()
        .load_compartments(&namespace)
        .unwrap()
        .into_iter()
        .filter(|row| row.end_message < 6)
        .collect();
    arm.store()
        .replace_compartments(&namespace, &imported)
        .unwrap();
    assert!(
        arm.state().entries.contains_key(&6),
        "recovered window: {:?}",
        arm.state().entries.keys().collect::<Vec<_>>()
    );
    publish_summary(&arm, 8);
    assert_eq!(arm.notice(4, 90_000, None, Vec::new()).await, "ok");
    let view: view::CompactionView = serde_json::from_str(&arm.views().last().unwrap().1).unwrap();
    let cut = view.cut.as_ref().expect("a new native cut");
    *arm.runner.lineage.lock().unwrap() = "native".into();
    request["lineage_id"] = json!("native");
    request["descends_from"] =
        json!({"lineage_id":view.lineage_id,"through_ordinal":cut.through_ordinal});
    let native = arm.setup(request.clone()).await;
    assert_eq!(native["answer"], "ready", "{native}");
    assert!(adopted(&arm.state()));
    arm.restart();
    assert_eq!(arm.setup(request).await["answer"], "ready");
    assert!(adopted(&arm.state()));
}
