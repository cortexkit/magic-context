use super::*;

// An OS lock also covers nextest's separate test processes. Fixture work
// must not compete with the timed Setup call, and runs outside its budget.
fn large_fixture() -> std::fs::File {
    let scratch = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(scratch.join("werni-cut-fixture.lock"))
        .unwrap();
    file.lock().unwrap();
    file
}

async fn cut_fixture(rig: &Rig) -> (Value, u64) {
    let previous = rig.runner.entries.lock().unwrap().clone();
    let keep = if rig.state().standalone_move.is_some() {
        previous.len() as u64
    } else {
        0
    };
    rig.fill(4_100);
    for entry in rig.runner.entries.lock().unwrap().iter_mut() {
        let mut message = entry.message.clone();
        message["parts"] = json!([{"id": format!("p{}", entry.ordinal), "type":"text", "text":"retained conversation text ".repeat(80)}]);
        *entry = ReadMessage::new(entry.ordinal, entry.mid.clone(), message)
            .with_tags(entry.tags.clone());
    }
    if keep > 0 {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.splice(..keep as usize, previous);
    }
    let store = rig.h.store.get().unwrap();
    let namespace = rig.state().namespace();
    let mut history = store.load_compartments(&namespace).unwrap();
    let sequence = history.iter().map(|row| row.sequence).max().unwrap_or(0) + 1;
    let start = history
        .iter()
        .map(|row| row.end_message)
        .max()
        .map_or(0, |end| end + 1);
    assert!(start < 199);
    history.push(mc_store::StoredCompartment {
        sequence,
        start_message: start,
        end_message: 199,
        end_message_id: "m199#0".into(),
        title: "completed retained-window prefix".into(),
        content: "completed history before the retained window".into(),
        p1: Some("completed history before the retained window".into()),
        importance: 50,
        ..Default::default()
    });
    store.replace_compartments(&namespace, &history).unwrap();
    store.arm_soft_refresh(&namespace).unwrap();
    let seq = rig.state().seq + 1;
    deliver(rig, seq, 90_000, None).await;
    let version = rig.newest().unwrap();
    deliver(rig, seq + 1, 1_000, Some(version)).await;
    let state = rig.state();
    let cut = state.newest_published_cut().unwrap_or_else(|| {
        panic!(
            "cut unavailable: {:?}",
            super::super::cut_runtime::measurements::take(store)
        )
    });
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":cut.first_ordinal - 1});
    request["request_id"] = json!("undelivered-descent");
    request["view_due_max_ms"] = json!(10_000);
    (request, version)
}

async fn deliver(rig: &Rig, seq: u64, size: u64, applied: Option<u64>) {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let mut notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        rig.runner.lineage.lock().unwrap().clone(),
        last.ordinal,
        contract::digest::content_digest(&last.message),
        size,
        "fixture",
    )
    .with_window(100_000);
    if let Some(version) = applied {
        notice = notice.with_applied_view_version(version);
    }
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };
    rig.h.advance_compaction("fixture", &message).await.unwrap();
}

fn assert_bounded_due(answer: &Value, version: u64) {
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(serde_json::to_vec(answer).unwrap().len() < 4 * 1024 * 1024 - 1024);
    assert!(answer["view_due"]["version"].as_u64().unwrap() > version);
    assert_eq!(
        answer["initial"]["range"]["from"],
        answer["initial"]["range"]["to"]
    );
    assert!(answer.get("checkpoint").is_none());
}

#[tokio::test]
async fn oversized_cut_setup_returns_bounded_view_due_within_budget() {
    let _fixture = large_fixture();
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let (request, version) = cut_fixture(&rig).await;
    let started = std::time::Instant::now();
    let answer = rig.op("compaction.setup", request).await;
    let elapsed = started.elapsed();
    eprintln!("oversized_cut_setup_ms={}", elapsed.as_millis());
    assert!(elapsed < Duration::from_secs(10));
    assert_bounded_due(&answer, version);
    let due = rig
        .get(answer["view_due"]["version"].as_u64().unwrap())
        .await;
    assert_eq!(answer["view_due"]["digest"], due.digest);
    assert_eq!(due.lineage_id, "L2");
    assert!(due.cut.is_none());
}

#[tokio::test]
async fn replayed_cut_setup_never_replays_oversized_initial() {
    let _fixture = large_fixture();
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let (request, version) = cut_fixture(&rig).await;
    let first = rig.op("compaction.setup", request.clone()).await;
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_bounded_due(&answer, version);
    assert_eq!(answer["view_due"], first["view_due"]);
    let mut without_cap = request.clone();
    without_cap
        .as_object_mut()
        .unwrap()
        .remove("view_due_max_ms");
    let generation = rig.state().generation;
    let refused = rig.op("compaction.setup", without_cap).await;
    assert_eq!(refused["code"], "misconfigured");
    assert_eq!(rig.state().generation, generation);

    // Reproduce a record written before reply bounding: the runner never
    // received the saved inline answer, so the same request must be repaired.
    let published = rig
        .get(answer["view_due"]["version"].as_u64().unwrap())
        .await;
    let mut legacy = rig.state();
    legacy.initial["initial"]["replacement"] =
        serde_json::from_slice(&rig.render(&published)).unwrap();
    legacy.initial["initial"]["range"]["to"] = json!(published.covers_through.ordinal + 1);
    legacy.initial.as_object_mut().unwrap().remove("view_due");
    assert!(serde_json::to_vec(&legacy.initial).unwrap().len() > 4 * 1024 * 1024);
    legacy.initial_stored = false;
    legacy.save(rig.h.store.get().unwrap(), &[]).unwrap();
    rig.h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .forget(&rig.reference);
    let repaired = rig.op("compaction.setup", request.clone()).await;
    assert_bounded_due(&repaired, version);
    assert_eq!(
        rig.op("compaction.setup", request).await["view_due"],
        repaired["view_due"]
    );
}

fn parent_notice(rig: &Rig, seq: u64) -> cortexkit_bus_trait::Message {
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        1_000,
        "fixture",
    );
    cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    }
}

#[tokio::test]
async fn parent_notices_after_undelivered_setup_keep_generation_and_cut() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.history(20, "history");
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    let cut = state.newest_published_cut().unwrap().clone();
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":cut.first_ordinal - 1});
    rig.op("compaction.setup", request.clone()).await;
    let generation = rig.state().generation;
    let message = parent_notice(&rig, 2);
    for _ in 0..3 {
        rig.h.advance_compaction("fixture", &message).await.unwrap();
        assert_eq!(rig.state().generation, generation);
        assert_eq!(rig.state().lineage.as_deref(), Some("L2"));
        assert_eq!(
            rig.state().newest_published_cut().unwrap().version,
            cut.version
        );
    }
    assert_eq!(rig.op("compaction.setup", request).await["answer"], "ready");
}

#[tokio::test]
async fn due_view_renders_inline_bytes_and_keeps_the_parent_view_immutable() {
    let _clock = crate::tests::fixed_clock();
    let mut first_requests = Vec::new();
    let mut next_requests = Vec::new();
    for due_requested in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let rig = Rig::new(dir.path()).await;
        rig.fill(40);
        rig.history(20, "history");
        rig.notice(1, 90_000, None).await;
        let version = rig.newest().unwrap();
        rig.queue(&[178]).await;
        rig.notice(2, 90_000, Some(version)).await;
        // Prepare the new cut before the runner acknowledges it. The head
        // and retained edits therefore come from different versions.
        let parent = rig.state();
        let cut = parent.newest_published_cut().unwrap().clone();
        let before = rig.get(cut.version).await;
        let store = rig.h.store.get().unwrap();
        let archive_before = store
            .load_async_cut_bundle(&rig.reference, &cut.key())
            .unwrap()
            .unwrap();
        let note = rig
            .tool(
                7,
                "ctx_note",
                json!({"action":"write","content":"cut durable note"}),
            )
            .await;
        assert_eq!(note["isError"], false);
        let mut request = serde_json::to_value(&parent.setup).unwrap();
        request["lineage_id"] = json!("L2");
        request["descends_from"] =
            json!({"lineage_id":"L","through_ordinal":cut.first_ordinal - 1});
        if due_requested {
            request["view_due_max_ms"] = json!(10_000);
        }
        let answer = rig.op("compaction.setup", request).await;
        let applied = if due_requested {
            assert_eq!(
                answer["initial"]["range"]["from"],
                answer["initial"]["range"]["to"]
            );
            let due = answer["view_due"]["version"]
                .as_u64()
                .expect("small cut also uses a due view");
            let fetched = rig.get(due).await;
            assert!(due > cut.version);
            assert!(fetched.cut.is_none());
            assert_eq!(fetched.lineage_id, "L2");
            first_requests.push(rig.render(&fetched));
            Some(due)
        } else {
            assert!(answer.get("view_due").is_none());
            first_requests.push(serde_json::to_vec(&answer["initial"]["replacement"]).unwrap());
            None
        };
        assert_eq!(rig.get(cut.version).await, before);
        let archive_after = store
            .load_async_cut_bundle(&rig.reference, &cut.key())
            .unwrap()
            .unwrap();
        assert_eq!(archive_after.seed, archive_before.seed);
        assert_eq!(archive_after.metadata, archive_before.metadata);
        assert_eq!(
            archive_after.history_objects,
            archive_before.history_objects
        );
        if due_requested {
            let note = rig.tool(7, "ctx_note", json!({"action":"read"})).await;
            assert!(note["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("cut durable note"));
        }
        *rig.runner.lineage.lock().unwrap() = "L2".into();
        rig.runner.entries.lock().unwrap().push(
            ReadMessage::new(
                40,
                "m40",
                json!({"info":{"id":"m40","role":"assistant","time":{"created":1}},
                "parts":[{"id":"p40","type":"text","text":"new assistant tail"}]}),
            )
            .with_tags(vec![tags::PartTag::tagged("0", "§220§")]),
        );
        rig.notice(4, 1_000, applied).await;
        let views = store.load_async_compaction_views(&rig.reference).unwrap().0;
        let latest = views
            .iter()
            .filter_map(|(_, raw, _, _)| serde_json::from_str::<view::CompactionView>(raw).ok())
            .filter(|view| view.lineage_id == "L2")
            .max_by_key(|view| view.view_version);
        next_requests.push(if let Some(latest) = latest {
            rig.render(&latest)
        } else {
            let mut messages: Vec<Value> =
                serde_json::from_slice(first_requests.last().unwrap()).unwrap();
            messages.push(
                json!({"info":{"id":"m40","role":"assistant","time":{"created":1}},
                "parts":[{"id":"p40","type":"text","text":"new assistant tail"}]}),
            );
            serde_json::to_vec(&messages).unwrap()
        });
        let first: Vec<Value> = serde_json::from_slice(first_requests.last().unwrap()).unwrap();
        let later: Vec<Value> = serde_json::from_slice(next_requests.last().unwrap()).unwrap();
        assert_eq!(
            serde_json::to_vec(&later[..first.len()]).unwrap(),
            *first_requests.last().unwrap(),
            "a deferred append preserves every previously rendered byte"
        );
    }
    assert_eq!(
        first_requests[0], first_requests[1],
        "due and inline first requests are byte-identical"
    );
    assert_eq!(
        next_requests[0], next_requests[1],
        "acknowledging the due view preserves later rendering"
    );
}

#[tokio::test]
async fn repeatedly_failing_notice_reuses_its_reset_generation() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(20);
    rig.notice(1, 90_000, None).await;
    let mut message = parent_notice(&rig, 2);
    message
        .headers
        .insert("through_digest".into(), "0".repeat(64));
    let notice = notice::AdvanceNotice::from_headers(&message.headers).unwrap();
    message.digest = notice.digest().parse().unwrap();
    rig.h.advance_compaction("fixture", &message).await.unwrap();
    let generation = rig.state().generation;
    for _ in 0..3 {
        rig.h.advance_compaction("fixture", &message).await.unwrap();
        assert_eq!(rig.state().generation, generation);
    }
}

#[tokio::test]
async fn moved_cut_retry_after_reset_generations_recovers_and_adopts_due_view() {
    let _fixture = large_fixture();
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_session::moved_rig(dir.path(), true).await;
    let prepared = rig.newest().unwrap();
    rig.notice(1, 1_000, Some(prepared)).await;
    assert!(super::super::offline_first_pass::adopted(&rig.state()));
    let adoption_first = rig.state().lineage_first_ordinal;
    let (request, parent_version) = cut_fixture(&rig).await;
    assert!(rig.state().standalone_move.is_some());
    let parent_raw = rig.get(parent_version).await;
    let first = rig.op("compaction.setup", request.clone()).await;
    assert_bounded_due(&first, parent_version);
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    // Simulate a descent whose reply was lost, followed by failed-notice resets.
    // Its published cut archive survives even though the active window is gone.
    while state.generation < 98 {
        state.reset(store).unwrap();
    }
    state.cut_seed = None;
    state.cut_first_ordinal = None;
    state.lineage_first_ordinal = adoption_first;
    state.save(store, &[]).unwrap();
    rig.h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .forget(&rig.reference);
    let generation = rig.state().generation;
    let message = parent_notice(&rig, 3);
    for _ in 0..3 {
        rig.h.advance_compaction("fixture", &message).await.unwrap();
        assert_eq!(rig.state().generation, generation);
        assert!(rig.state().lineage.is_none());
    }
    super::setup_recovery_copy::rehearse(&rig, request.clone()).await;
    let started = std::time::Instant::now();
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_bounded_due(&answer, parent_version);
    let due = answer["view_due"]["version"].as_u64().unwrap();
    let after_setup = rig.state();
    assert!(after_setup.generation > generation);
    assert!(!store
        .load_compartments(&after_setup.namespace())
        .unwrap()
        .is_empty());
    assert!(after_setup.cut_seed.is_some());
    assert_eq!(rig.get(parent_version).await, parent_raw);
    assert_eq!(
        rig.op("compaction.setup", request).await["view_due"],
        answer["view_due"]
    );
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    let cut = after_setup.newest_published_cut().unwrap();
    rig.runner
        .entries
        .lock()
        .unwrap()
        .retain(|row| row.ordinal >= cut.first_ordinal);
    let origin = cut.first_ordinal;
    {
        let mut head = rig.runner.head_override.lock().unwrap();
        *head = Some(json!({"lineage_id":"L2", "first_ordinal":origin,
            "cut":{"mid":format!("m{}",origin-1), "digest":"0".repeat(64),"written_at":1}}));
    }
    rig.notice(4, 1_000, Some(due)).await;
    assert_eq!(rig.state().lineage.as_deref(), Some("L2"));
    assert_eq!(rig.state().applied, Some(due));
    assert_eq!(rig.state().generation, after_setup.generation);
}

#[tokio::test]
async fn oversized_cut_without_view_due_refuses_before_descent() {
    let _fixture = large_fixture();
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let (mut request, version) = cut_fixture(&rig).await;
    request.as_object_mut().unwrap().remove("view_due_max_ms");
    let before = rig.state();
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_eq!(answer["answer"], "refuse");
    assert_eq!(answer["code"], "misconfigured");
    assert_eq!(rig.state().generation, before.generation);
    assert_eq!(rig.state().lineage, before.lineage);
    let mut reset = rig.state();
    for _ in 0..3 {
        reset.reset(rig.h.store.get().unwrap()).unwrap();
    }
    rig.h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .forget(&rig.reference);
    request["view_due_max_ms"] = json!(10_000);
    let retry = rig.op("compaction.setup", request).await;
    assert_bounded_due(&retry, version);
}

#[tokio::test]
async fn unknown_cut_refusal_does_not_save_a_partial_descent() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.history(20, "history");
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    let store = rig.h.store.get().unwrap();
    let before = store
        .load_async_compaction_rows(&rig.reference)
        .unwrap()
        .unwrap()
        .state;
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"never-published","through_ordinal":20});
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["code"], "unknown_cut");
    assert_eq!(
        store
            .load_async_compaction_rows(&rig.reference)
            .unwrap()
            .unwrap()
            .state,
        before
    );
}

#[tokio::test]
async fn interrupted_positive_cap_cut_setup_retries_with_a_durable_due_view() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.history(20, "history");
    rig.notice(1, 90_000, None).await;
    let version = rig.newest().unwrap();
    rig.notice(2, 1_000, Some(version)).await;
    let state = rig.state();
    let cut = state.newest_published_cut().unwrap();
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":cut.first_ordinal - 1});
    request["view_due_max_ms"] = json!(10_000);
    super::super::cut_runtime::crash_after_descent_begin_for_test();
    let crashed = rig
        .h
        .dispatch_value(
            7,
            json!({"method":"compaction.setup","params":request.clone()}),
        )
        .await;
    super::super::cut_runtime::clear_crash_after_descent_begin_for_test();
    assert!(matches!(crashed, HandlerOutcome::Error { ref code, .. } if code == "transient"));
    let generation = rig.state().generation;
    let parent = parent_notice(&rig, 3);
    for _ in 0..3 {
        rig.h.advance_compaction("fixture", &parent).await.unwrap();
        assert_eq!(rig.state().generation, generation);
        assert_eq!(rig.state().lineage.as_deref(), Some("L2"));
    }
    let answer = rig.op("compaction.setup", request.clone()).await;
    assert_bounded_due(&answer, version);
    assert_eq!(rig.state().generation, generation);
    let due = answer["view_due"]["version"].as_u64().unwrap();
    assert_eq!(rig.get(due).await.lineage_id, "L2");
    assert_eq!(
        rig.op("compaction.setup", request).await["view_due"],
        answer["view_due"]
    );
}

#[tokio::test]
async fn positive_cap_before_any_applied_view_keeps_the_unedited_raw_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.history(20, "history");
    rig.queue(&[178]).await;
    rig.notice(1, 90_000, None).await;
    let state = rig.state();
    assert!(state.applied.is_none());
    let cut = state.newest_published_cut().unwrap();
    let mut expected: Vec<Value> = serde_json::from_str(&cut.head).unwrap();
    for row in rig
        .runner
        .entries
        .lock()
        .unwrap()
        .iter()
        .filter(|row| row.ordinal >= cut.first_ordinal)
    {
        let mut message = row.message.clone();
        message["parts"] = json!(message["parts"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(index, part)| render_part(part, row.tags[index].tag.as_deref(), true))
            .collect::<Vec<_>>());
        expected.push(message);
    }
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request["lineage_id"] = json!("L2");
    request["descends_from"] = json!({"lineage_id":"L","through_ordinal":cut.first_ordinal - 1});
    request["view_due_max_ms"] = json!(10_000);
    let answer = rig.op("compaction.setup", request).await;
    assert_bounded_due(&answer, cut.version);
    let fetched = rig
        .get(answer["view_due"]["version"].as_u64().unwrap())
        .await;
    assert_eq!(rig.render(&fetched), serde_json::to_vec(&expected).unwrap());
    assert!(fetched.ranges.iter().all(|range| match range {
        view::ViewRange::Keep { edits, .. } => edits.is_empty(),
        _ => true,
    }));
}
