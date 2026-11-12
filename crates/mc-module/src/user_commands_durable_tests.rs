use super::*;
use crate::store::{CommandAnswer, Store};
use sha2::{Digest, Sha256};

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn record(request: &wire::ModuleRunRequest, stored_at: i64) -> CommandAnswer {
    CommandAnswer {
        request_id: request.request_id.clone(),
        request_digest: format!("{:x}", Sha256::digest(serde_jcs::to_vec(request).unwrap())),
        answer: wire::RunReply::new("scheduled"),
        stored_at,
        principal: wire::ADMITTED_CALLER.into(),
        caller: request.caller.clone(),
    }
}

#[tokio::test]
async fn user_commands_durable_answer_replays_after_restart_without_publication() {
    for outcome in ["scheduled", "refused", "transport"] {
        let (mut session, client, settings) = ready();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("mode3.db")).unwrap());
        session.set_store(Some(store.clone()));
        *client.refuse.lock().unwrap() = outcome == "refused";
        *client.fail_apply.lock().unwrap() = outcome == "transport";
        let p = preview(&mut session, &client, &settings, "flush").await;
        let request =
            wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "restart");
        let answer = session
            .command_run(&client, &settings, &request)
            .await
            .unwrap();
        assert_eq!(
            answer.outcome,
            if outcome == "scheduled" {
                "scheduled"
            } else {
                "failed"
            }
        );
        let saved = store.load(&session.key).unwrap();
        assert_eq!(saved.command_answers.len(), 1);
        assert_eq!(saved.command_answers[0].answer, answer);
        assert_eq!(saved.command_answers[0].principal, wire::ADMITTED_CALLER);
        assert_eq!(saved.command_answers[0].caller, request.caller);
        assert_eq!(saved.command_answers[0].request_digest.len(), 64);
        let module = crate::module::Module::new(
            Client::default(),
            settings.clone(),
            None,
            Some(Store::open(&dir.path().join("mode3.db")).unwrap()),
        );
        let caller = subc_protocol::Principal::Reserved {
            module_id: "occipital".into(),
        };
        let body = serde_json::to_vec(&json!({"method":"commands.run", "params":request})).unwrap();
        assert_eq!(
            module.command_request(&caller, &body).await.unwrap(),
            serde_json::to_value(&answer).unwrap()
        );
        module.idle_foreground(&session.key).await.unwrap();
        let (mut restarted, restarted_client, _, _, _) = fixture();
        restarted.set_store(Some(store.clone()));
        restarted.restore(saved);
        assert_eq!(
            restarted
                .command_run(&restarted_client, &settings, &request)
                .await
                .unwrap(),
            answer
        );
        let mut conflict = request;
        conflict.caller = wire::Caller::new("phone", "phone");
        assert_eq!(
            restarted
                .command_run(&restarted_client, &settings, &conflict)
                .await
                .unwrap()
                .outcome,
            "request_conflict"
        );
        assert!(restarted_client.offered.lock().unwrap().is_empty());
        assert!(restarted_client.reads.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn user_commands_crash_before_apply_reply_replays_the_write_ahead_answer() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("mode3.db")).unwrap());
    session.set_store(Some(store.clone()));
    let p = preview(&mut session, &client, &settings, "flush").await;
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "interrupted");
    let key = session.key.clone();
    let during_apply = store.clone();
    let during_key = key.clone();
    *client.before_apply.lock().unwrap() = Some(Box::new(move || {
        let saved = during_apply.load(&during_key).unwrap();
        assert_eq!(saved.command_answers[0].answer.outcome, "scheduled");
        assert_eq!(saved.unconfirmed.len(), 1);
        panic!("simulated module exit before apply_view answers");
    }));
    let repeated = request.clone();
    let settings_after_restart = settings.clone();
    let run = tokio::spawn(async move { session.command_run(&client, &settings, &request).await });
    assert!(run.await.unwrap_err().is_panic());
    let saved = store.load(&key).unwrap();
    let expected = saved.command_answers[0].answer.clone();
    let (mut restarted, restarted_client, _, _, _) = fixture();
    restarted.restore(saved);
    assert_eq!(
        restarted
            .command_run(&restarted_client, &settings_after_restart, &repeated)
            .await
            .unwrap(),
        expected
    );
    assert!(restarted_client.offered.lock().unwrap().is_empty());
    assert!(restarted_client.reads.lock().unwrap().is_empty());
}

#[tokio::test]
async fn user_commands_rollback_save_failure_returns_error_and_replays_durable_state() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let store = Arc::new(Store::open(&path).unwrap());
    session.set_store(Some(store.clone()));
    *client.refuse.lock().unwrap() = true;
    *client.before_apply.lock().unwrap() = Some(Box::new(move || {
        rusqlite::Connection::open(path).unwrap().execute_batch(
            "CREATE TRIGGER refuse_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'rollback write refused'); END;",
        ).unwrap();
    }));
    let p = preview(&mut session, &client, &settings, "flush").await;
    let request = wire::ModuleRunRequest::new(
        preview_request(&session, "flush"),
        p.version,
        "unknown-outcome",
    );
    let error = session
        .command_run(&client, &settings, &request)
        .await
        .unwrap_err();
    assert_eq!(error.code, "unavailable");
    assert!(error.message.contains("retry with the same request_id"));
    let saved = store.load(&session.key).unwrap();
    assert_eq!(saved.command_answers[0].answer.outcome, "scheduled");
    assert_eq!(saved.unconfirmed.len(), 1);
    let expected = saved.command_answers[0].answer.clone();
    let (mut restarted, restarted_client, _, _, _) = fixture();
    restarted.restore(saved);
    assert_eq!(
        restarted
            .command_run(&restarted_client, &settings, &request)
            .await
            .unwrap(),
        expected
    );
    assert!(restarted_client.offered.lock().unwrap().is_empty());
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap(),
        expected
    );
    assert_eq!(client.offered.lock().unwrap().len(), 1);
}

#[test]
fn user_commands_every_save_prunes_expired_answers_and_omits_an_empty_list() {
    let (mut session, _, _) = ready();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    let store = Arc::new(Store::open(&path).unwrap());
    session.set_store(Some(store.clone()));
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), "preview", "retained");
    let live = record(&request, now() - 23 * 60 * 60 * 1000);
    let mut expired = record(&request, now() - 25 * 60 * 60 * 1000);
    expired.request_id = "expired".into();
    session.command_answers = Arc::new(vec![expired.clone(), live.clone()]);
    session.save().unwrap();
    let saved = store.load(&session.key).unwrap();
    assert_eq!(saved.command_answers.as_ref(), &[live]);
    session.command_answers = Arc::new(vec![expired]);
    session.save().unwrap();
    assert!(store.load(&session.key).unwrap().command_answers.is_empty());
    let raw: String = rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT state FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert!(!raw.contains("command_answers"));
    let (mut restarted, _, _, _, _) = fixture();
    restarted.restore(store.load(&session.key).unwrap());
    assert!(restarted.command_answers.is_empty());
}

#[tokio::test]
async fn user_commands_per_session_bound_refuses_new_ids_without_evicting_live_answers() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("mode3.db")).unwrap());
    session.set_store(Some(store.clone()));
    let p = preview(&mut session, &client, &settings, "flush").await;
    let request =
        wire::ModuleRunRequest::new(preview_request(&session, "flush"), p.version, "retained-0");
    session.command_answers = Arc::new(
        (0..256)
            .map(|i| {
                let mut request = request.clone();
                request.request_id = format!("retained-{i}");
                record(&request, now())
            })
            .collect(),
    );
    session.save().unwrap();
    let mut new_request = request.clone();
    new_request.request_id = "overflow".into();
    assert_eq!(
        session
            .command_run(&client, &settings, &new_request)
            .await
            .unwrap_err()
            .code,
        "command_capacity"
    );
    assert_eq!(session.command_answers.len(), 256);
    assert_eq!(
        session
            .command_run(&client, &settings, &request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert_eq!(store.load(&session.key).unwrap().command_answers.len(), 256);
    assert!(client.offered.lock().unwrap().is_empty());
    Arc::make_mut(&mut session.command_answers)[0].stored_at = now() - 25 * 60 * 60 * 1000;
    assert_eq!(
        session
            .command_run(&client, &settings, &new_request)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert_eq!(session.command_answers.len(), 256);
    assert!(!session
        .command_answers
        .iter()
        .any(|answer| answer.request_id == "retained-0"));
    assert_eq!(client.offered.lock().unwrap().len(), 1);
}
