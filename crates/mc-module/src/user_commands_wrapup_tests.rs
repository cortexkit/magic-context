use super::*;

pub(super) fn ready() -> (Session, Client, Settings) {
    let (mut session, client, settings) = super::ready();
    session.index = Default::default();
    session.queued.clear();
    session.features.summarizer = true;
    session.conditions.last_prompt_tokens = Some(100);
    session.index.extend((1..=24).map(|ordinal| {
        Entry::new(
            ordinal,
            format!("m{ordinal}"),
            if [1, 5, 23].contains(&ordinal) {
                Role::User
            } else {
                Role::Assistant
            },
            ordinal,
            vec![Part::new(
                "p",
                PartBody::Text {
                    text: "a".repeat(400).into(),
                },
            )],
        )
    }));
    (session, client, settings)
}

pub(super) fn request(session: &Session, keep: Option<u64>) -> wire::ModulePreviewRequest {
    let mut request = preview_request(session, "wrapup");
    if let Some(keep) = keep {
        request.args.insert("messages_to_keep".into(), json!(keep));
    }
    request
}

pub(super) async fn preview_keep(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    keep: Option<u64>,
) -> wire::Preview {
    let request = request(session, keep);
    let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":request})).unwrap();
    let decoded = commands::decode(&body).unwrap().unwrap();
    serde_json::from_value(
        commands::execute(Some(session), client, settings, decoded)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn wrapup_preview_counts_raw_messages_and_tokens_without_mutating() {
    let (mut session, client, settings) = ready();
    let before = session.durable();
    let p = preview_keep(&mut session, &client, &settings, None).await;
    assert!(p.available, "{p:?}");
    let facts = p.facts.as_ref().unwrap();
    assert_eq!(facts[0].data.value, Some(4.0));
    assert_eq!(facts[1].data.value, Some(400.0));
    assert_eq!(facts[2].data.value, Some(20.0));
    assert!(p.effect.as_ref().unwrap().contains("next rebuild"));
    assert!(p.effect.as_ref().unwrap().contains("flush"));
    assert_eq!(before, session.durable());
    assert!(client.reads.lock().unwrap().is_empty());
    assert!(client.offered.lock().unwrap().is_empty());
    let zero = preview_keep(&mut session, &client, &settings, Some(0)).await;
    assert_eq!(zero.facts.unwrap()[0].data.value, Some(24.0));
}

#[tokio::test]
async fn wrapup_unavailable_empty_within_keep_and_no_summarizer() {
    for (case, reason) in [
        ("empty", "nothing_to_summarize"),
        ("keep", "within_keep"),
        ("disabled", "summarizer_disabled"),
        ("snap", "no_safe_boundary"),
    ] {
        let (mut session, client, settings) = ready();
        if case == "empty" {
            session.index = Default::default();
        }
        if case == "disabled" {
            session.features.summarizer = false;
        }
        let keep = match case {
            "keep" => Some(24),
            "snap" => Some(22),
            _ => Some(0),
        };
        let p = preview_keep(&mut session, &client, &settings, keep).await;
        assert!(!p.available, "{p:?}");
        assert_eq!(p.reason.as_deref(), Some(reason));
    }
}

#[tokio::test]
async fn wrapup_run_starts_one_requested_range_and_replays_request() {
    let (mut session, client, settings) = ready();
    let p = preview_keep(&mut session, &client, &settings, Some(2)).await;
    let r = wire::ModuleRunRequest::new(request(&session, Some(2)), p.version, "wrapup-once");
    let answer = session.command_run(&client, &settings, &r).await.unwrap();
    assert_eq!(answer.outcome, "scheduled");
    let run = session
        .summary_due(&settings)
        .expect("manual run below pressure threshold");
    assert_eq!((run.from, run.until), (1, 23));
    assert!(
        session.summary_due(&settings).is_none(),
        "one concurrent run"
    );
    assert_eq!(
        session.command_run(&client, &settings, &r).await.unwrap(),
        answer
    );
    assert!(session.summary_due(&settings).is_none());
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "wrapup never rebuilds"
    );
}

#[tokio::test]
async fn wrapup_preview_stales_on_new_history_summary_or_running_state() {
    for change in ["history", "summary", "running"] {
        let (mut session, client, settings) = ready();
        let p = preview_keep(&mut session, &client, &settings, Some(0)).await;
        let r = wire::ModuleRunRequest::new(request(&session, Some(0)), p.version, change);
        match change {
            "history" => {
                session.index.extend(vec![text(25, "new")]);
            }
            "summary" => {
                session.summaries.edit();
            }
            _ => session.summarizing = true,
        }
        assert_eq!(
            session
                .command_run(&client, &settings, &r)
                .await
                .unwrap()
                .outcome,
            "preview_stale"
        );
    }
}

#[tokio::test]
async fn wrapup_running_summary_waits_and_new_command_replaces_target() {
    let (mut session, client, settings) = ready();
    session.summarizing = true;
    let p = preview_keep(&mut session, &client, &settings, Some(0)).await;
    assert!(p.available);
    assert!(serde_json::to_string(&p)
        .unwrap()
        .contains("already running"));
    let r = wire::ModuleRunRequest::new(request(&session, Some(0)), p.version, "while-running");
    assert_eq!(
        session
            .command_run(&client, &settings, &r)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    assert!(session.summary_due(&settings).is_none());
    let p = preview_keep(&mut session, &client, &settings, Some(2)).await;
    let r = wire::ModuleRunRequest::new(request(&session, Some(2)), p.version, "replacement");
    assert_eq!(
        session
            .command_run(&client, &settings, &r)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    session.summarizing = false;
    assert_eq!(session.summary_due(&settings).unwrap().until, 23);
}

async fn schedule(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    keep: u64,
) -> wire::ModuleRunRequest {
    let p = preview_keep(session, client, settings, Some(keep)).await;
    let r = wire::ModuleRunRequest::new(request(session, Some(keep)), p.version, "drain");
    assert_eq!(
        session
            .command_run(client, settings, &r)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    r
}

async fn publish(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    from: u64,
    until: u64,
) {
    let compartment = serde_json::from_value(json!({
        "sequence": session.summaries.len(), "start_message": from, "end_message": until - 1,
        "start_message_id": format!("m{from}"), "end_message_id": format!("m{}", until - 1),
        "title": "Earlier work", "content": "A summary of the earlier work.", "p1": "Earlier work."
    }))
    .unwrap();
    session
        .summary_finished(
            client,
            settings,
            Ok(Some(run::Summarized {
                validated: crate::summary::validate::ValidatedChunk {
                    compartments: vec![compartment],
                    ..Default::default()
                },
                publication: None,
                continuation: None,
            })),
            100,
        )
        .await;
}

#[tokio::test]
async fn wrapup_drains_capped_runs_past_quota_to_anchored_target_without_rebuild() {
    let (mut session, client, settings) = ready();
    session.conditions.context_window = 1_000;
    session.conditions.output_reserve = 0;
    session.drain.spent = u64::MAX / 2;
    session.drain.window_started_at = session.clock();
    schedule(&mut session, &client, &settings, 0).await;
    // Later messages do not move the target approved by the person.
    session.index.extend(vec![text(25, "arrived later")]);
    let mut runs = 0;
    let mut through = 0;
    while let Some(run) = session.pending_wrapup_summary(&settings) {
        runs += 1;
        assert!(runs < 25, "drain must make progress");
        assert_eq!(run.from, through + 1);
        assert!(run.until <= 25);
        assert_eq!(run.force_keep_last_compartment, run.until == 25);
        through = run.until - 1;
        publish(&mut session, &client, &settings, run.from, run.until).await;
    }
    assert!(runs > 1, "per-run cap still applies");
    assert_eq!(through, 24);
    assert!(session.durable().wrapup_target.is_none());
    assert!(session.summary_unshown);
    assert!(client.offered.lock().unwrap().is_empty());
}

#[tokio::test]
async fn wrapup_target_answer_and_progress_survive_restart_and_revert_cancels_target() {
    let (mut session, client, settings) = ready();
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(crate::store::Store::open(&dir.path().join("mode3.db")).unwrap());
    session.set_store(Some(store.clone()));
    let r = schedule(&mut session, &client, &settings, 2).await;
    let saved = store.load(&session.key).unwrap();
    assert_eq!(saved.wrapup_target.as_ref().unwrap().until, 23);
    let (mut restored, client, _) = ready();
    restored.restore(saved);
    restored.index_ready = true;
    assert_eq!(
        restored
            .command_run(&client, &settings, &r)
            .await
            .unwrap()
            .outcome,
        "scheduled"
    );
    let status = preview(&mut restored, &client, &settings, "status").await;
    assert!(serde_json::to_string(&status)
        .unwrap()
        .contains("Wrapup target"));
    let mut replacement = text(22, "different history");
    replacement.mid = "replaced-22".into();
    restored.index.extend(vec![replacement]);
    assert!(restored.pending_wrapup_summary(&settings).is_none());
    assert!(restored.durable().wrapup_target.is_none());
}

#[tokio::test]
async fn wrapup_waits_for_account_and_failures_pause_without_losing_target() {
    use crate::summary::account_wait::{AccountWait, SendKind};
    let (mut session, client, settings) = ready();
    schedule(&mut session, &client, &settings, 0).await;
    let run = session.pending_wrapup_summary(&settings).unwrap();
    let now = crate::summary::account_wait::now_ms();
    session
        .summary_finished(
            &client,
            &settings,
            Err(run::SummaryError::AccountWait(AccountWait {
                at_ms: now,
                until_ms: now + 60_000,
                code: "account_limit_exhausted".into(),
                send: SendKind::TurnOne,
            })),
            now,
        )
        .await;
    assert!(session.pending_wrapup_summary(&settings).is_none());
    let p = preview_keep(&mut session, &client, &settings, Some(0)).await;
    assert!(p.available);
    assert!(serde_json::to_string(&p)
        .unwrap()
        .contains("Account wait; target waits too"));
    session.account_wait.as_mut().unwrap().refusal.until_ms = now - 1;
    let resumed = session.pending_wrapup_summary(&settings).unwrap();
    assert_eq!((resumed.from, resumed.until), (run.from, run.until));
    session
        .summary_finished(
            &client,
            &settings,
            Err(run::SummaryError::Failed("provider failed".into())),
            now,
        )
        .await;
    assert!(session.pending_wrapup_summary(&settings).is_none());
    assert!(session.durable().wrapup_target.is_some());
    let p = preview_keep(&mut session, &client, &settings, Some(0)).await;
    assert!(serde_json::to_string(&p)
        .unwrap()
        .contains("failure backoff"));
}

#[tokio::test]
async fn wrapup_no_progress_stops_drain_and_invalid_arguments_are_rejected() {
    let (mut session, client, settings) = ready();
    schedule(&mut session, &client, &settings, 0).await;
    assert!(session.pending_wrapup_summary(&settings).is_some());
    session
        .summary_finished(&client, &settings, Ok(None), 100)
        .await;
    assert!(session.pending_wrapup_summary(&settings).is_none());
    assert!(session.durable().wrapup_target.is_some());
    for value in [
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992_u64),
        json!("2"),
        json!(null),
    ] {
        let mut r = request(&session, None);
        r.args.insert("messages_to_keep".into(), value);
        let body = serde_json::to_vec(&json!({"method":"commands.preview", "params":r})).unwrap();
        assert_eq!(
            commands::decode(&body).err().unwrap().code,
            "invalid_params"
        );
    }
}
