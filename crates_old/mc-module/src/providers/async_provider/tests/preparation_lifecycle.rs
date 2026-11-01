use super::*;

#[path = "werni_first_request.rs"]
mod werni_first_request;
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
        due_view: None,
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
    request_bytes: Vec<Vec<u8>>,
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
        self.request_bytes
            .push(serde_json::to_vec(&request).unwrap());
        self.requests.push(request.clone());
        request
    }

    fn view(&mut self, view: &view::CompactionView, entries: &[ReadMessage]) -> Vec<Value> {
        let request = apply_view(view, entries);
        self.rebuilds += usize::from(self.requests.last() != Some(&request));
        self.request_bytes
            .push(serde_json::to_vec(&request).unwrap());
        self.requests.push(request.clone());
        request
    }
}

fn move_record(paths: &StorePaths, session: &str) -> offline_move::MoveRecord {
    offline_move::read_move_record(
        &rusqlite::Connection::open(&paths.context_db).unwrap(),
        session,
    )
    .unwrap()
    .unwrap()
    .unwrap()
}

fn assert_no_applied_drops(request: &[Value], moved: &offline_move::MoveRecord) {
    for drop in moved
        .drops
        .iter()
        .filter(|drop| drop.kind == offline_move::DropKind::Applied)
    {
        assert!(
            request
                .iter()
                .flat_map(|message| message["parts"].as_array().into_iter().flatten())
                .all(|part| part["id"].as_str() != Some(drop.part.as_str())),
            "request retained applied drop {}:{}",
            drop.mid,
            drop.part
        );
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

/// A runner that holds its first step for a due view gets the history head
/// alone plus `view_due` naming the prepared view (compaction-provider §4),
/// never the rendered window. Applying that view gives exactly the first
/// request the inline answer would have given, and adopts the preparation.
#[tokio::test]
async fn a_due_view_setup_sends_only_the_head_and_the_view_gives_the_prepared_request() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let with_cap = |request: &mut Value| request["view_due_max_ms"] = json!(30_000);
    let (prep, outcome) =
        prepared_with(store.path(), project.path(), fixture_stores, with_cap).await;
    let OfflineOutcome::Prepared(report) = outcome else {
        panic!("{outcome:?}")
    };
    let runner = Served::new(prep.served.clone(), 7);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        runner,
        config(),
    );
    let inline = arm.state().initial.clone();
    let (version, view_json, _) = arm.views().into_iter().next().unwrap();
    let prepared_view: view::CompactionView = serde_json::from_str(&view_json).unwrap();
    let expected = apply_view(&prepared_view, &prep.served);

    let mut request = setup_request(&prep.session, "fixture");
    with_cap(&mut request);
    let answer = arm.setup(request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(
        answer["view_due"],
        json!({"version": version, "digest": prepared_view.digest})
    );
    let origin = report.proof.origin;
    assert_eq!(
        answer["initial"]["range"],
        json!({"from": origin, "to": origin}),
        "a due-view Setup replaces none of the runner's messages"
    );
    let head = match prepared_view.ranges.first() {
        Some(view::ViewRange::Replace { from, to, bytes }) if from == to => {
            serde_json::from_str::<Value>(bytes).unwrap()
        }
        _ => json!([]),
    };
    assert_eq!(answer["initial"]["replacement"], head);
    let sizes = (
        serde_json::to_vec(&answer).unwrap().len(),
        serde_json::to_vec(&inline).unwrap().len(),
    );
    assert!(
        sizes.0 < sizes.1,
        "head-only answer {} vs inline {}",
        sizes.0,
        sizes.1
    );
    // The runner fetches the due view and applies it before its first model
    // step: that request is exactly the prepared one.
    let fetched = response(
        arm.h
            .dispatch_value(
                CHANNEL,
                json!({"method":"view.get","params":{"session_ref": arm.reference(), "view_version": version}}),
            )
            .await,
    );
    assert_eq!(fetched["answer"], "view", "{fetched}");
    let fetched: view::CompactionView = decode(&fetched["view"]).unwrap();
    assert_eq!(fetched.digest, prepared_view.digest);
    assert_eq!(apply_view(&fetched, &prep.served), expected);
    assert_eq!(arm.notice(1, 0, Some(version), Vec::new()).await, "ok");
    assert!(adopted(&arm.state()));

    // A runner that did not ask for a due view still gets the inline answer,
    // which fits one frame here.
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let runner = Served::new(prep.served.clone(), 7);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        runner,
        config(),
    );
    let inline = arm.state().initial.clone();
    let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
    assert!(answer.get("view_due").is_none(), "{answer}");
    assert_eq!(answer["initial"], inline["initial"]);
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
            assert_eq!(
                answer["checkpoint"]["message_count"],
                answer["initial"]["range"]["from"]
            );
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
            assert_eq!(
                model.request_bytes.last().unwrap(),
                &serde_json::to_vec(&request).unwrap()
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
        let views = arm.views();
        let adopted_view: view::CompactionView = serde_json::from_str(
            &views
                .iter()
                .find(|(version, _, _)| *version == 1)
                .unwrap()
                .1,
        )
        .unwrap();
        assert_eq!(adopted_view.view_version, 1);
        assert!(arm
            .announced
            .0
            .lock()
            .unwrap()
            .contains(&adopted_view.view_version));
        model.view(&adopted_view, &arm.runner.entries.lock().unwrap());
        assert_eq!(model.request_bytes.last(), model.request_bytes.first());
        assert_eq!(
            model.rebuilds, 1,
            "adopting the prepared view must not rebuild"
        );
        arm.restart();
        assert_eq!(
            arm.setup(setup_request(&prep.session, "fixture")).await["initial"],
            stored
        );
        assert!(adopted(&arm.state()));
    }
}

#[tokio::test]
async fn repeated_setup_returns_the_stored_answer_without_reads_or_writes() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 7),
        config(),
    );
    let request = setup_request(&prep.session, "fixture");
    let first = arm.setup(request.clone()).await;
    assert_eq!(first["answer"], "ready", "{first}");
    let before = store_rows(&prep.paths);
    arm.runner.read_from.lock().unwrap().clear();
    let repeated = arm.setup(request).await;
    assert_eq!(
        serde_json::to_vec(&repeated).unwrap(),
        serde_json::to_vec(&first).unwrap()
    );
    assert_eq!(store_rows(&prep.paths), before);
    assert!(arm.runner.read_from.lock().unwrap().is_empty());
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

#[tokio::test]
async fn first_notice_mismatch_keeps_prepared_bytes_and_adopts_the_fresh_generation() {
    let _clock = crate::tests::fixed_clock();
    for change in ["proof", "changed_row", "removed_row"] {
        for notice_first in [false, true] {
            let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
            let moved = move_record(&prep.paths, &prep.session);
            if change == "proof" {
                rewrite_offline_marker(&prep, |marker| {
                    marker["inputs"] = json!("different-inputs");
                });
            }
            let mut current = prep.served.clone();
            let index = current
                .iter()
                .position(|entry| !moved.drops.iter().any(|drop| drop.mid == entry.mid))
                .unwrap();
            match change {
                "changed_row" => {
                    let ordinal = current[index].ordinal;
                    edit_entry(&mut current, ordinal);
                }
                "removed_row" => {
                    current.remove(index);
                    for entry in &mut current[index..] {
                        entry.ordinal -= 1;
                    }
                }
                _ => {}
            }
            let mut arm = Arm::open(
                store.path(),
                project.path(),
                &prep.session,
                Served::new(current.clone(), 7),
                config(),
            );
            let prepared_answer = arm.state().initial;
            let mut model = ModelRecorder::default();
            if !notice_first {
                let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
                assert_eq!(answer["answer"], "ready", "{answer}");
                assert_eq!(answer["initial"], prepared_answer["initial"]);
                assert!(arm.runner.read_from.lock().unwrap().is_empty());
                assert_no_applied_drops(&model.setup(&answer, &current), &moved);
            } else {
                // The runner holds the offline answer even when it sends a notice first.
                assert_no_applied_drops(&model.setup(&prepared_answer, &current), &moved);
            }
            assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok", "{change}");
            let state = arm.state();
            assert!(adopted(&state));
            assert_eq!(state.generation, 1, "{change}");
            assert_eq!(state.initial, prepared_answer);
            let bound = state.standalone_move.unwrap();
            assert!(bound.pending.is_none());
            assert_eq!(bound.bound_drops.len(), moved.drops.len());
            let views = arm.views();
            assert_eq!(views.len(), 2, "one reconciliation view: {change}");
            assert_eq!(views[0].2, -1);
            let view: view::CompactionView = serde_json::from_str(&views[1].1).unwrap();
            assert_no_applied_drops(&model.view(&view, &current), &moved);
            assert!(model.rebuilds <= 2, "at most one extra rebuild: {change}");
            assert_eq!(
                serde_json::to_value(move_record(&prep.paths, &prep.session)).unwrap(),
                serde_json::to_value(&moved).unwrap()
            );
            arm.restart();
            for _ in 0..2 {
                let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
                assert_eq!(answer["answer"], "ready", "{answer}");
                assert_eq!(answer["initial"], prepared_answer["initial"]);
            }
            assert!(adopted(&arm.state()));
        }
    }
}

#[tokio::test]
async fn command_interruptions_refuse_live_setup_and_recover_on_immediate_offline_rerun() {
    let _clock = crate::tests::fixed_clock();
    for stage in ["importing", "after_setup", "after_binding"] {
        let (store, project, work) = (
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
        );
        let (paths, session, served) = moved_stores(store.path(), fixture_stores);
        let moved = serde_json::to_value(move_record(&paths, &session)).unwrap();
        let args = command_args(
            work.path(),
            &paths,
            &session,
            &export(&served, LINEAGE, 7),
            &setup_file(project.path(), &setup_request(&session, "fixture")),
        );
        crate::providers::async_provider::offline_first_pass::INTERRUPT_PREPARATION
            .with(|flag| flag.set(Some(stage)));
        let outcome = first_pass(&args, project.path(), &fixture::NoHolders).await;
        assert!(
            matches!(outcome, Err(command::RunError::Interrupted(ref reason)) if reason.contains(stage)),
            "{stage}: {outcome:?}"
        );
        let arm = Arm::open(
            store.path(),
            project.path(),
            &session,
            Served::new(served.clone(), 7),
            config(),
        );
        let state = arm.state();
        let marker = state.offline_first_pass.as_ref().unwrap();
        assert_eq!(marker.state, PreparationState::Preparing);
        assert!(marker.proof.is_none());
        assert_eq!(state.is_importing_stage(), stage == "importing");
        if stage == "after_binding" {
            assert!(state.standalone_move.as_ref().unwrap().pending.is_none());
            assert!(!state
                .standalone_move
                .as_ref()
                .unwrap()
                .bound_drops
                .is_empty());
        }
        let before = store_rows(&paths);
        assert_eq!(
            arm.setup(setup_request(&session, "fixture")).await["code"],
            "moved_session_unprepared",
            "{stage}"
        );
        assert_eq!(store_rows(&paths), before);
        drop(arm);
        let outcome = first_pass(&args, project.path(), &fixture::NoHolders)
            .await
            .unwrap();
        let OfflineOutcome::Prepared(report) = outcome else {
            panic!("{stage}: {outcome:?}")
        };
        assert_eq!(report.generation, 1);
        assert_eq!(
            serde_json::to_value(move_record(&paths, &session)).unwrap(),
            moved
        );
        let arm = Arm::open(
            store.path(),
            project.path(),
            &session,
            Served::new(served, 7),
            config(),
        );
        let answer = arm.setup(setup_request(&session, "fixture")).await;
        assert_eq!(answer["answer"], "ready", "{stage}: {answer}");
        assert_no_applied_drops(
            &ModelRecorder::default().setup(&answer, &[]),
            &move_record(&paths, &session),
        );
        assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
        assert!(adopted(&arm.state()));
    }
}

#[tokio::test]
async fn rerun_recovers_missing_preparation_setup_mismatch_and_changed_inputs() {
    let _clock = crate::tests::fixed_clock();
    for change in ["missing", "setup", "inputs"] {
        let (store, project, work) = (
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
            tempfile::tempdir().unwrap(),
        );
        let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
        let moved = move_record(&prep.paths, &prep.session);
        let mut request = setup_request(&prep.session, "fixture");
        if change == "missing" {
            rewrite_offline_marker(&prep, |marker| *marker = Value::Null);
        } else if change == "setup" {
            request = setup_request(&prep.session, "fixture-2");
        } else {
            let writer = McStore::open_for_test(&fixture::store_descriptor(store.path())).unwrap();
            writer
                .seed_user_profile_for_test(&["changed after preparation".into()], 999)
                .unwrap();
        }
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            Served::new(prep.served.clone(), 7),
            config(),
        );
        let before = store_rows(&prep.paths);
        let answer = arm.setup(request.clone()).await;
        if change == "inputs" {
            assert_eq!(answer["answer"], "ready");
        } else {
            assert_eq!(answer["code"], "moved_session_unprepared");
        }
        assert_eq!(store_rows(&prep.paths), before);
        drop(arm);
        let args = command_args(
            work.path(),
            &prep.paths,
            &prep.session,
            &export(&prep.served, LINEAGE, 3),
            &setup_file(project.path(), &request),
        );
        let outcome = first_pass(&args, project.path(), &fixture::NoHolders)
            .await
            .unwrap();
        assert!(
            matches!(outcome, OfflineOutcome::Prepared(ref report) if report.generation == 1),
            "{change}: {outcome:?}"
        );
        assert_eq!(
            serde_json::to_value(move_record(&prep.paths, &prep.session)).unwrap(),
            serde_json::to_value(&moved).unwrap()
        );
        assert!(matches!(
            first_pass(&args, project.path(), &fixture::NoHolders).await,
            Ok(OfflineOutcome::Unchanged(_))
        ));
        let arm = Arm::open(
            store.path(),
            project.path(),
            &prep.session,
            Served::new(prep.served, 7),
            config(),
        );
        let answer = arm.setup(request).await;
        assert_eq!(answer["answer"], "ready", "{change}: {answer}");
        assert_no_applied_drops(&ModelRecorder::default().setup(&answer, &[]), &moved);
        assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
        drop(arm);
        assert_eq!(
            refusal_code(first_pass(&args, project.path(), &fixture::NoHolders).await),
            "offline_already_adopted"
        );
    }
}

#[tokio::test]
async fn non_moved_records_keep_existing_offline_rerun_refusals_without_writes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let paths = StorePaths {
        opencode_db: dir.path().join("opencode.db"),
        context_db: dir.path().join("context.db"),
        store_db: dir.path().join("store.db"),
    };
    for (stage, code) in [
        ("live", "async_record_exists"),
        ("incomplete", "offline_run_incomplete"),
        ("different", "offline_state_differs"),
    ] {
        let mut state = rig.state();
        assert!(state.standalone_move.is_none());
        if stage != "live" {
            let mut offline = marker(&serde_json::to_value(&state.setup).unwrap());
            if stage == "different" {
                offline.setup = "earlier-setup".into();
                offline.proof = Some(EntryInputProof {
                    lineage: LINEAGE.into(),
                    origin: 0,
                    count: 0,
                    end: 0,
                    digest: "unused".into(),
                });
            }
            state.offline_first_pass = Some(offline);
            state.save(store, &[]).unwrap();
            rig.h.resident_cache().forget(&rig.reference);
        }
        let before = store_rows(&paths);
        let outcome = rig
            .h
            .offline_first_pass(
                &crate::providers::async_provider::offline_first_pass::OfflineSetup {
                    project_root: dir.path().into(),
                    runner_module: MODULE.into(),
                    runner_describe: runner_describe(),
                    request: state.setup,
                },
            )
            .await;
        assert!(
            matches!(outcome, Err(crate::providers::async_provider::offline_first_pass::OfflineError::Refused(actual, _)) if actual == code),
            "{stage}: {outcome:?}"
        );
        assert_eq!(store_rows(&paths), before);
    }
}

#[tokio::test]
async fn project_scoped_work_counts_a_real_full_input_pass_and_cross_thread_work() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, _) = prepared(store.path(), project.path(), fixture_stores).await;
    let reference = runner_session_ref(MODULE, "opencode", &prep.session);
    let other_project = tempfile::tempdir().unwrap();
    let worker_reference = reference.clone();
    let worker_project = other_project.path().to_path_buf();
    tokio::task::spawn_blocking(move || {
        scaling_tests::view_work::engine(&worker_reference, &worker_project, 123);
    })
    .await
    .unwrap();
    let work = scaling_tests::view_work::take_for(&reference, project.path());
    assert!(!prep.served.is_empty());
    assert_eq!(
        work.engine_input,
        prep.served.len(),
        "the offline pass must count its entire input"
    );
    assert_eq!(
        scaling_tests::view_work::take_for(&reference, other_project.path()).engine_input,
        123,
        "work on another thread is counted without contaminating this store"
    );
}
