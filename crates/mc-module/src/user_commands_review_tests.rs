use super::*;

#[tokio::test]
async fn user_commands_preview_erases_refusal_history_and_changes_the_next_ordinary_pass() {
    let mut queues = Vec::new();
    for with_preview in [false, true] {
        let (mut session, client, settings) = ready();
        let old = ("old".into(), "p".into());

        // A runner refusal records one failed attempt at the queued drop.
        *client.refuse.lock().unwrap() = true;
        let (view, _) = session.build(&settings, None, false, None);
        assert!(!session.publish(&client, view.unwrap()).await);
        assert!(session.refused_once.contains(&old));

        // The retry loses its acknowledgement, but the runner applies it.
        // Reading it back leaves a queued drop already covered by that view.
        *client.refuse.lock().unwrap() = false;
        *client.fail_apply.lock().unwrap() = true;
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.unwrap();
        assert!(!session.publish(&client, view.clone()).await);
        let mut applied = AppliedViewAnswer::default();
        applied.view = Some(view);
        *client.applied.lock().unwrap() = Some(applied);
        session.adopt_runner_view(&client).await;
        assert!(session.queued.contains(&old));
        assert!(session.refused_once.contains(&old));

        if with_preview {
            let p = preview(&mut session, &client, &settings, "flush").await;
            assert_eq!(p.reason.as_deref(), Some("nothing_to_land"));
        }

        // Both sessions receive exactly the same new work. The next ordinary
        // rebuild and refusal must not depend on whether a palette was opened.
        session.index.extend(vec![text(3, "tail")]);
        session.queued.insert(("new prompt".into(), "p".into()));
        *client.fail_apply.lock().unwrap() = false;
        *client.refuse.lock().unwrap() = true;
        let (view, _) = session.build(&settings, None, false, None);
        assert!(!session.publish(&client, view.unwrap()).await);
        queues.push(session.queued.clone());
    }
    assert_eq!(
        queues[0], queues[1],
        "a read-only preview must not reset the repeated-refusal guard"
    );
}

#[tokio::test]
async fn user_commands_refused_flush_discards_queued_work_instead_of_saving_the_rollback() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
    session.set_store(Some(store.clone()));

    // Establish a real earlier refusal, not an artificial queue marker.
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, None);
    assert!(!session.publish(&client, view.unwrap()).await);
    let before = session.queued.clone();
    assert_eq!(before.len(), 1);
    assert_eq!(session.refused_once, before);
    session.save().unwrap();

    let p = preview(&mut session, &client, &settings, "flush").await;
    assert!(p.available, "{p:?}");
    let request = wire::ModuleRunRequest::new(
        preview_request(&session, "flush"),
        p.version,
        "refused-flush-rollback",
    );
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "failed"
    );
    let saved = store.load(&session.key).unwrap();
    assert_eq!(session.latest, None);
    assert!(session.unconfirmed.is_empty());
    assert_eq!(
        (session.queued, saved.queued),
        (before.clone(), before),
        "a failed person-run flush must preserve pending work in memory and on disk"
    );
}

#[tokio::test]
async fn user_commands_preview_keeps_the_complete_saved_document_byte_identical() {
    for already_covered in [false, true] {
        let (mut session, client, settings) = ready();
        let key = ("old".into(), "p".into());
        *client.refuse.lock().unwrap() = true;
        let (view, _) = session.build(&settings, None, false, None);
        assert!(!session.publish(&client, view.unwrap()).await);
        if already_covered {
            *client.refuse.lock().unwrap() = false;
            *client.fail_apply.lock().unwrap() = true;
            let (view, _) = session.build(&settings, None, false, None);
            let view = view.unwrap();
            assert!(!session.publish(&client, view.clone()).await);
            let mut applied = AppliedViewAnswer::default();
            applied.view = Some(view);
            *client.applied.lock().unwrap() = Some(applied);
            session.adopt_runner_view(&client).await;
        }
        session.app.stamps.insert(key.clone(), 123);
        session.app_projection.dirty.insert("old".into());
        let before = serde_json::to_vec(&session.durable()).unwrap();
        let stamps = session.app.stamps.clone();
        let dirty = session.app_projection.dirty.clone();
        let p = preview(&mut session, &client, &settings, "flush").await;
        assert_eq!(p.available, !already_covered);
        assert_eq!(serde_json::to_vec(&session.durable()).unwrap(), before);
        assert_eq!(session.app.stamps, stamps);
        assert_eq!(session.app_projection.dirty, dirty);
        assert!(session.refused_once.contains(&key));
    }
}

#[tokio::test(start_paused = true)]
async fn user_commands_discarded_preview_does_not_cancel_the_live_checkpoint_timer() {
    let (mut session, client, settings) = ready();
    let (fired, answer) = tokio::sync::oneshot::channel();
    let timer = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let _ = fired.send(());
    });
    tokio::task::yield_now().await;
    session.app_arm_snapshot(timer.abort_handle());
    assert!(
        preview(&mut session, &client, &settings, "flush")
            .await
            .available
    );
    tokio::time::advance(std::time::Duration::from_secs(1)).await;
    answer
        .await
        .expect("discarding a preview cancelled the live timer");
}

#[tokio::test]
async fn user_commands_failed_run_restores_all_saved_fields_except_answer_and_reserved_version() {
    for transport in [false, true] {
        let (mut session, client, settings) = ready();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
        session.set_store(Some(store.clone()));
        *client.refuse.lock().unwrap() = true;
        let (view, _) = session.build(&settings, None, false, None);
        assert!(!session.publish(&client, view.unwrap()).await);
        session.app.stamps.insert(("old".into(), "p".into()), 123);
        let before = serde_json::to_value(session.durable()).unwrap();
        let refusal_markers = session.refused_once.clone();
        let p = preview(&mut session, &client, &settings, "flush").await;
        let request = wire::ModuleRunRequest::new(
            preview_request(&session, "flush"),
            p.version,
            "exact-rollback",
        );
        *client.fail_apply.lock().unwrap() = transport;
        assert_eq!(
            session
                .command_run(&client, &settings, &request)
                .await
                .unwrap()
                .outcome,
            "failed"
        );
        assert_eq!(session.refused_once, refusal_markers);
        let mut after = serde_json::to_value(store.load(&session.key).unwrap()).unwrap();
        assert!(after["version"].as_u64().unwrap() > before["version"].as_u64().unwrap());
        assert_eq!(after["command_answers"][0]["answer"]["outcome"], "failed");
        after.as_object_mut().unwrap().remove("command_answers");
        after["version"] = before["version"].clone();
        assert_eq!(
            after, before,
            "failed flush changed the saved session transaction"
        );
    }
}
