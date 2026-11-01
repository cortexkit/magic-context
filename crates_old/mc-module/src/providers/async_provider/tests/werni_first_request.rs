use super::*;

#[tokio::test]
async fn review_werni_cached_and_uncached_preserve_prepared_view_and_bound_drops() {
    let _clock = crate::tests::fixed_clock();
    let (cached_dir, oracle_dir, project) = (
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
        tempfile::tempdir().unwrap(),
    );
    let (cached_prep, _) = prepared(cached_dir.path(), project.path(), werni_shaped_stores).await;
    let (oracle_prep, _) = prepared(oracle_dir.path(), project.path(), werni_shaped_stores).await;
    let cached = Arm::open(
        cached_dir.path(),
        project.path(),
        &cached_prep.session,
        Served::new(cached_prep.served.clone(), 127),
        config(),
    );
    let oracle = Arm::open(
        oracle_dir.path(),
        project.path(),
        &oracle_prep.session,
        Served::new(oracle_prep.served.clone(), 127),
        config(),
    );
    oracle
        .h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .oracle = true;

    let initial = serde_json::to_vec(&cached.state().initial).unwrap();
    let epoch = cached.state().engine.rebuild_epoch;
    let bound =
        serde_json::to_vec(&cached.state().standalone_move.as_ref().unwrap().bound_drops).unwrap();
    assert!(!cached
        .state()
        .standalone_move
        .unwrap()
        .bound_drops
        .is_empty());
    assert_eq!(
        initial,
        serde_json::to_vec(&oracle.state().initial).unwrap()
    );
    assert_eq!(
        bound,
        serde_json::to_vec(&oracle.state().standalone_move.unwrap().bound_drops).unwrap()
    );
    assert_eq!(cached.views(), oracle.views());
    let mut cached_model = ModelRecorder::default();
    let mut oracle_model = ModelRecorder::default();
    let left = cached
        .setup(setup_request(&cached_prep.session, "fixture"))
        .await;
    let right = oracle
        .setup(setup_request(&oracle_prep.session, "fixture"))
        .await;
    assert_eq!(
        serde_json::to_vec(&left).unwrap(),
        serde_json::to_vec(&right).unwrap()
    );
    cached_model.setup(&left, &cached_prep.served);
    oracle_model.setup(&right, &oracle_prep.served);
    assert_eq!(cached_model.request_bytes, oracle_model.request_bytes);
    let moved = move_record(&cached_prep.paths, &cached_prep.session);
    assert_eq!(moved.compartments.len(), 92);
    assert_eq!(moved.message_count, 5340);
    assert_eq!(
        moved
            .drops
            .iter()
            .filter(|drop| drop.kind == offline_move::DropKind::Applied)
            .count(),
        2720
    );
    for seq in 1..=3 {
        if seq > 1 {
            let ordinal = 9084 + seq;
            let row = appended(&cached_prep.session, ordinal, 100_000 + seq);
            cached.runner.entries.lock().unwrap().push(row.clone());
            oracle.runner.entries.lock().unwrap().push(row);
        }
        assert_eq!(cached.notice(seq, 0, None, Vec::new()).await, "ok");
        assert_eq!(oracle.notice(seq, 0, None, Vec::new()).await, "ok");
        assert_eq!(
            cached.views(),
            oracle.views(),
            "notice {seq}: all raw views and edits"
        );
        for (arm, model) in [(&cached, &mut cached_model), (&oracle, &mut oracle_model)] {
            let view: view::CompactionView =
                serde_json::from_str(&arm.views().last().unwrap().1).unwrap();
            let rendered = model.view(&view, &arm.runner.entries.lock().unwrap());
            assert_no_applied_drops(&rendered, &moved);
        }
        assert_eq!(cached_model.request_bytes, oracle_model.request_bytes);
        for arm in [&cached, &oracle] {
            let state = arm.state();
            assert!(adopted(&state));
            assert_eq!(
                state.engine.rebuild_epoch, epoch,
                "notice {seq}: no extra rebuild"
            );
            assert_eq!(serde_json::to_vec(&state.initial).unwrap(), initial);
            assert_eq!(
                serde_json::to_vec(&state.standalone_move.unwrap().bound_drops).unwrap(),
                bound
            );
        }
    }
}

fn werni_shaped_stores(dir: &Path) -> (StorePaths, String) {
    // The measured session's cut boundary is at message position 5341; it has
    // 92 imported summaries, one discarded summary covering 187 returned rows,
    // 3559 already-raw rows, and 2720 retained applied drops. Contents are
    // synthetic, never a live-store copy.
    let paths = fixture::write_synthetic_stores(
        dir,
        &fixture::Synthetic {
            messages: 9086,
            tail: 3746,
            text_bytes: 64,
            compartments: 92,
        },
    );
    let session = fixture::SYNTHETIC_SESSION.to_owned();
    let mut context = rusqlite::Connection::open(&paths.context_db).unwrap();
    let tx = context.transaction().unwrap();
    tx.execute("DELETE FROM compartments", []).unwrap();
    for sequence in 1..=93 {
        let (start, end) = if sequence == 93 {
            (5340, 5526)
        } else {
            ((sequence - 1) * 5340 / 92, sequence * 5340 / 92 - 1)
        };
        tx.execute(
            "INSERT INTO compartments(session_id,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,importance,legacy,created_at,harness)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8,50,0,1,'opencode')",
            rusqlite::params![
                session,
                sequence,
                start + 1,
                end + 1,
                format!("msg_{start:07}"),
                format!("msg_{end:07}"),
                format!("history {sequence}"),
                format!("Imported history {sequence}: durable decision for turns {start} through {end}.")
            ],
        )
        .unwrap();
    }
    tx.execute_batch(
        "UPDATE session_meta SET compaction_marker_state=json_set(compaction_marker_state,'$.targetEndMessageId','msg_0005526');
         UPDATE tags SET status='active';
         UPDATE tags SET status='dropped' WHERE tag_number IN (
             SELECT tag_number FROM tags
             WHERE (tool_owner_message_id >= 'msg_0005340' OR (type='message' AND message_id >= 'msg_0005340'))
               AND tag_number NOT IN (SELECT tag_id FROM pending_ops)
             ORDER BY tag_number LIMIT 2720
         );",
    )
    .unwrap();
    tx.commit().unwrap();
    let plan = offline_move::plan(&paths, &session).unwrap();
    assert_eq!(plan.message_count, 5340);
    assert_eq!(plan.record.cut, "msg_0005340");
    assert_eq!(plan.record.compartments.len(), 92);
    assert_eq!(plan.dropped_summaries.len(), 1);
    assert_eq!(plan.returned_raw.len(), 187);
    (paths, session)
}

#[tokio::test]
async fn moved_werni_shape_first_request_equals_prepared_bytes_with_one_rebuild() {
    let _clock = crate::tests::fixed_clock();
    let (store, project) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (prep, outcome) = prepared(store.path(), project.path(), werni_shaped_stores).await;
    let OfflineOutcome::Prepared(report) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(report.proof.origin, 5340);
    assert_eq!(report.proof.count, 3746);
    assert_eq!(report.proof.end, 9086);
    assert_eq!(report.published_views, 1);
    let arm = Arm::open(
        store.path(),
        project.path(),
        &prep.session,
        Served::new(prep.served.clone(), 127),
        config(),
    );
    let moved = move_record(&prep.paths, &prep.session);
    assert_eq!(moved.compartments.len(), 92);
    let imported = arm
        .store()
        .load_compartments(&arm.state().namespace())
        .unwrap();
    assert_eq!(imported.len(), 92);
    for (index, row) in imported.iter().enumerate() {
        let sequence = index + 1;
        let start = (sequence - 1) * 5340 / 92;
        let end = sequence * 5340 / 92 - 1;
        assert_eq!(row.sequence, sequence as i64);
        assert_eq!(row.start_message, start as i64);
        assert_eq!(row.end_message, end as i64);
        assert_eq!(row.title, format!("history {sequence}"));
        assert_eq!(
            row.content,
            format!(
                "Imported history {sequence}: durable decision for turns {start} through {end}."
            )
        );
    }
    assert_eq!(
        moved
            .drops
            .iter()
            .filter(|drop| drop.kind == offline_move::DropKind::Applied)
            .count(),
        2720
    );
    assert!(moved
        .drops
        .iter()
        .any(|drop| drop.kind == offline_move::DropKind::Queued));
    let prepared_view: view::CompactionView = serde_json::from_str(&arm.views()[0].1).unwrap();
    assert_eq!(prepared_view.view_version, 1);
    let expected = apply_view(&prepared_view, &prep.served);
    let expected_bytes = serde_json::to_vec(&expected).unwrap();
    assert_no_applied_drops(&expected, &moved);
    // Fully dropped messages may disappear, including queued drops applied by
    // the pass. Every message with a part outside the carried drops must remain.
    for entry in &prep.served {
        for part in parts(&entry.message).unwrap().iter() {
            if moved.drops.iter().any(|drop| {
                drop.mid == entry.mid && part["id"].as_str() == Some(drop.part.as_str())
            }) {
                continue;
            }
            let rendered = expected
                .iter()
                .find(|message| message["info"]["id"] == entry.mid)
                .unwrap_or_else(|| panic!("missing non-dropped retained row {}", entry.mid));
            assert!(
                parts(rendered)
                    .unwrap()
                    .iter()
                    .any(|kept| kept["id"] == part["id"]),
                "missing non-dropped retained part {}:{}",
                entry.mid,
                part["id"]
            );
        }
    }
    for message in &expected {
        let Some(mid) = message["info"]["id"].as_str() else {
            continue;
        };
        let Some(index) = mid
            .strip_prefix("msg_")
            .and_then(|id| id.parse::<u64>().ok())
        else {
            continue;
        };
        assert!(index >= 5340, "raw content below U: {mid}");
    }
    let answer = arm.setup(setup_request(&prep.session, "fixture")).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(
        answer["checkpoint"]["message_count"],
        answer["initial"]["range"]["from"]
    );
    assert!(
        answer["initial"]["replacement"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| {
                message["info"]["role"] == "user"
                    && message["parts"].as_array().unwrap().iter().any(|part| {
                        part["synthetic"] == true
                            && part["text"]
                                .as_str()
                                .is_some_and(|text| text.contains("Imported history 92:"))
                    })
            }),
        "the first request must include the rendered imported history head"
    );
    assert_eq!(answer["initial"]["range"], json!({"from":5340,"to":9086}));
    let mut model = ModelRecorder::default();
    model.setup(&answer, &prep.served);
    assert_eq!(model.request_bytes[0], expected_bytes);
    assert_eq!(model.rebuilds, 1);
    assert_eq!(arm.notice(1, 0, None, Vec::new()).await, "ok");
    assert!(adopted(&arm.state()));
    assert_eq!(
        *arm.announced.0.lock().unwrap(),
        vec![prepared_view.view_version]
    );
    let views = arm.views();
    assert_eq!(views.len(), 1);
    let announced_view: view::CompactionView = serde_json::from_str(&views[0].1).unwrap();
    assert_no_applied_drops(&model.view(&announced_view, &prep.served), &moved);
    assert_eq!(model.request_bytes[1], expected_bytes);
    assert_eq!(
        model.rebuilds, 1,
        "first-notice adoption must reuse the prepared bytes"
    );
    assert!(arm
        .runner
        .read_from
        .lock()
        .unwrap()
        .iter()
        .all(|from| *from >= 5340));
}
