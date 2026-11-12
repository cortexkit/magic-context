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
