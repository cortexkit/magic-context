//! Review tests for the account wait: a summarizer send the runner held back
//! until an account has room. Each test names the property it checks; a
//! test that fails shows a case where the change does not keep it.

use super::*;
use crate::summary::account_wait::{now_ms, until, AccountWait, SendKind};
use crate::summary::run::account_wait_send_tests::{Answer, Client as SendClient};
use crate::summary::two_pass::turn_two;
use cortexkit_role_compaction::read::StepUsage;
use cortexkit_role_llm_runner::run::RunError;
use serde_json::json;

/// A head session at a 20% execute threshold of a 100,000-token usable
/// window, with no protected tail of its own.
fn head(entries: Vec<Entry>) -> (Session, Client, Settings) {
    let (mut session, client, _, _, _) = fixture();
    let mut settings = crate::config::resolve_for_test(
        json!({"execute_threshold_percentage": 20}),
        json!({}),
        "anthropic/claude-opus-4-1",
        100_000,
    );
    settings.protected_tokens = Some(0);
    session.preset = crate::catalog::Preset::Head;
    session.features = crate::preset::features(session.preset.as_str()).unwrap();
    session.conditions.context_window = 110_000;
    session.conditions.output_reserve = 10_000;
    session.conditions.model = ModelRef::new("anthropic", "claude-opus-4-1");
    session.index.extend(entries);
    session.index_ready = true;
    session.head_stale = false;
    at_usage(&mut session, 20.0);
    (session, client, settings)
}

fn entry(ordinal: u64, role: Role, text: String) -> Entry {
    let mut part = Part::new("p", PartBody::Text { text: text.into() });
    part.tag = Some(ordinal);
    let mut entry = Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, vec![part]);
    let mut usage = StepUsage::new();
    usage.reasoning_tokens = Some(0);
    entry.usage = Some(usage);
    entry
}

/// Sixteen turns of history worth a summary, then a short prompt and step.
fn ready_history() -> Vec<Entry> {
    let mut entries: Vec<Entry> = (1..=16)
        .map(|ordinal| {
            entry(
                ordinal,
                if ordinal % 2 == 1 {
                    Role::User
                } else {
                    Role::Assistant
                },
                "history ".repeat(1_000),
            )
        })
        .collect();
    entries.push(entry(17, Role::User, "task".into()));
    entries.push(entry(18, Role::Assistant, "step".into()));
    entries
}

/// One long autonomous turn: the person's only prompt is the first message,
/// and everything after it is the agent working, so nothing before the
/// prompt floor can be summarized until the floor is lifted.
fn long_turn_history() -> Vec<Entry> {
    let mut entries = vec![entry(
        1,
        Role::User,
        "Implement the long autonomous task".into(),
    )];
    for _ in 0..16 {
        let ordinal = entries.len() as u64 + 1;
        entries.push(entry(ordinal, Role::Assistant, "history ".repeat(1_000)));
        entries.push(entry(
            ordinal + 1,
            Role::User,
            "<system-reminder>Continue working</system-reminder>".into(),
        ));
    }
    entries
}

fn at_usage(session: &mut Session, percentage: f64) {
    session.conditions.last_prompt_tokens = Some((percentage * 1_000.0).round() as u64);
}

/// A refusal of a summary's first turn received just now, naming two
/// minutes.
fn refusal() -> AccountWait {
    AccountWait {
        code: "account_limit_exhausted".into(),
        until_ms: now_ms() + 120_000,
        at_ms: now_ms(),
        send: SendKind::TurnOne,
    }
}

/// End the summary run in progress with an account wait.
async fn refuse(session: &mut Session, client: &Client, settings: &Settings) {
    assert!(session.summarizing, "no summary run was in progress");
    session
        .summary_finished(
            client,
            settings,
            Err(run::SummaryError::AccountWait(refusal())),
            now_ms(),
        )
        .await;
}

/// Let the session's account wait run out.
fn wait_passes(session: &mut Session) {
    session
        .account_wait
        .as_mut()
        .expect("the session waits")
        .refusal
        .until_ms = now_ms() - 1;
}

/// The run that lifts the prompt floor met the account wait at its first
/// turn, so nothing was summarized. `summary_due` puts a floor mark back for
/// the run after the wait when the wait holds a run back before it starts; a
/// lift spent by a run the runner refused should come back the same way.
/// Instead `floor_lifted_for` stays set to the prompt, the mark cannot be
/// armed for that prompt again, and below the force band (from 85% usage,
/// where the protected tail shrinks by itself) no run starts after the wait
/// until the person writes a new prompt.
#[tokio::test]
async fn account_wait_review_a_floor_lift_spent_by_a_refused_run_comes_back_after_the_wait() {
    let (mut session, client, settings) = head(long_turn_history());
    // Preconditions: the first pass marks the floor, the second lifts it.
    assert!(session.decide_notice(&settings).summary.is_none());
    assert!(
        session.floor_pending_for.is_some(),
        "the fixture does not arm a floor mark"
    );
    assert!(
        session.decide_notice(&settings).summary.is_some(),
        "the floor lift started no run"
    );
    refuse(&mut session, &client, &settings).await;
    wait_passes(&mut session);
    // The next two notices may arm the mark again and then lift it.
    let first = session.decide_notice(&settings).summary.is_some();
    let second = session.decide_notice(&settings).summary.is_some();
    assert!(
        first || second,
        "no summary run starts after the wait (floor lifted for {:?}, mark {:?})",
        session.floor_lifted_for,
        session.floor_pending_for
    );
}

/// From 95% `account_wait_admits` lets one run per newest message start
/// inside a wait, and a refused try waits for newer history. A run started
/// at 96% that meets the wait is such a try already, whether it started with
/// no wait or as the first run after one; yet the wait it creates carries no
/// emergency mark, so the very next notice on the same history asks the
/// refusing accounts again before their named time.
#[tokio::test]
async fn account_wait_review_a_refused_run_at_emergency_usage_does_not_ask_again_for_the_same_history(
) {
    for after_a_wait in [false, true] {
        let (mut session, client, settings) = head(ready_history());
        if after_a_wait {
            assert!(session.decide_notice(&settings).summary.is_some());
            refuse(&mut session, &client, &settings).await;
            wait_passes(&mut session);
        }
        at_usage(&mut session, 96.0);
        assert!(
            session.decide_notice(&settings).summary.is_some(),
            "no run started at 96% (after a wait: {after_a_wait})"
        );
        refuse(&mut session, &client, &settings).await;
        let again = session.decide_notice(&settings).summary.is_some();
        assert!(
            !again,
            "a second run started on the same history right after the refusal (after a wait: {after_a_wait})"
        );
    }
}

/// A plain failure that arrives while a wait is held still counts as a
/// failure, and leaves the wait in place. The second turn's wait reaches the
/// session while its next first turn runs, as `Job::AccountWait` can.
#[tokio::test]
async fn account_wait_review_a_real_failure_during_a_wait_is_still_counted() {
    let (mut session, client, settings) = head(ready_history());
    assert!(session.decide_notice(&settings).summary.is_some());
    let spent = session.drain.spent;
    assert!(spent > 0);
    session.account_refused(AccountWait {
        send: SendKind::TurnTwo,
        ..refusal()
    });
    session
        .summary_finished(
            &client,
            &settings,
            Err(run::SummaryError::Failed(
                "the run ended error: boom".into(),
            )),
            now_ms(),
        )
        .await;
    assert_eq!(session.app.failures, 1);
    assert_eq!(
        session.app.last_error.as_deref(),
        Some("the run ended error: boom")
    );
    assert_eq!(session.drain.spent, spent, "the reservation stays spent");
    assert!(session.summaries_wait_for_account());
    assert!(session.decide_notice(&settings).summary.is_none());
}

/// A relative hint that is negative or not a number is no hint: the reset
/// instant, then the default wait, decide instead. On both arrival paths.
#[test]
fn account_wait_review_unusable_relative_hints_fall_back_to_the_reset() {
    const NOW: i64 = 1_800_000_000_000;
    let reset = (NOW + 60_000) as u64;
    for seconds in [-5.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(until(NOW, Some(seconds), Some(reset)), NOW + 60_000);
        assert_eq!(
            until(NOW, Some(seconds), None),
            NOW + crate::summary::account_wait::DEFAULT_WAIT_MS
        );
        let mut error = RunError::new("transient", "no account", "account_limit_exhausted");
        error.retry_after_secs = Some(seconds);
        error.resets_at_ms = Some(reset);
        let wait = AccountWait::of_run_error(&error, SendKind::TurnOne, NOW).unwrap();
        assert_eq!(wait.until_ms, NOW + 60_000, "run error, {seconds}");
    }
    // A refused send's detail with a negative float and no whole seconds.
    let detail = json!({"routing_code": "no_eligible_account", "class": "transient",
        "retry_after_secs": -1.0, "resets_at_ms": reset});
    let wait = AccountWait::of_refusal(
        "account_selection_refused",
        Some(&detail),
        SendKind::TurnOne,
        NOW,
    )
    .unwrap();
    assert_eq!(wait.until_ms, NOW + 60_000);
}

/// A second turn for a committed publication that carries one agent memory
/// due for classification and no candidate facts.
fn store_with_a_due_item() -> (tempfile::TempDir, crate::context_db::ContextDb) {
    let dir = tempfile::tempdir().unwrap();
    let db =
        crate::context_db::ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
                 VALUES ('publication', 'project', 'head', 1, 0);
             INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash,
                                  first_seen_at, created_at, updated_at, last_seen_at)
                 VALUES (1, 'project', 'project', 'swe:constraints', 'CONSTRAINTS', 'Releases need two reviewers.', 'hash', 0, 0, 0, 0);
             INSERT INTO memory_classification_items(project_path, memory_id, saved_revision,
                     source_session_id, tool_call_part_id, save_ordinal, excerpt)
                 VALUES ('project', 1, 1, 'head', 'call', 1, 'The person said releases need two reviewers.');",
        )
    })
    .unwrap();
    (dir, db)
}

fn turn_two_job() -> turn_two::Job {
    turn_two::Job {
        owner: SessionRef::new("runner", "pi", "head"),
        project: "project".into(),
        project_root: Some("/project".into()),
        continuation: run::Continuation {
            prompts: crate::summary::prompts::SummaryPrompts::bundled(),
            keep_child: false,
            child: crate::client::Child {
                session: SessionRef::new("runner", "pi", "summary-child"),
                project_root: Some("/project".into()),
            },
            model: ModelRef::new("provider", "model"),
            decision_id: "decision".into(),
            output_tokens: 1_000,
            language: None,
            publication_id: "publication".into(),
        },
        memory_enabled: true,
        auto_promote: true,
        embedding: None,
        authority: None,
    }
}

/// A second turn that meets the account wait revokes its stage, which
/// `Outcome::AccountWait` documents as "no attempt spent"; only its facts
/// get that. An agent memory waiting to be classified counts one send for
/// every `turn_two` row in `memory_stage_attempts` whose `request_json` lists
/// it under `items`, revoked or not (`ITEM_SENDS` in `turn_two.rs`). Three
/// waits use up the item's three sends, and it is never classified.
#[tokio::test]
async fn account_wait_review_a_turn_two_wait_spends_no_classification_attempt() {
    let (_dir, db) = store_with_a_due_item();
    for wait in 1..=4 {
        let client = SendClient::new(Answer::RefuseSend);
        let outcome = turn_two::run(&client, &db, &turn_two_job()).await;
        assert!(
            matches!(outcome, turn_two::Outcome::AccountWait(_)),
            "wait {wait}: the item was not sent again: {outcome:?}"
        );
        assert_eq!(*client.sends.lock().unwrap(), 1, "wait {wait}");
    }
}

/// A runner that answers every summarizer send with a run that first
/// reports `paused`, then `completed`.
struct PausingRunner {
    polls: Mutex<usize>,
}

impl RunnerClient for PausingRunner {
    async fn read(
        &self,
        _: &SessionRef,
        _: ReadRequest,
    ) -> Result<ReadPage, crate::client::ClientError> {
        unreachable!()
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, crate::client::ClientError> {
        unreachable!()
    }
    async fn applied_view(
        &self,
        _: &SessionRef,
    ) -> Result<AppliedViewAnswer, crate::client::ClientError> {
        unreachable!()
    }
    async fn send(
        &self,
        _: &SessionRef,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        unreachable!()
    }
    async fn send_child(
        &self,
        _: &crate::client::Child,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        let mut reply = SendReply::new("active");
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: RunResultRequest,
    ) -> Result<RunResult, crate::client::ClientError> {
        let mut polls = self.polls.lock().unwrap();
        *polls += 1;
        if *polls == 1 {
            let mut paused = RunResult::new("run", "paused");
            paused.reason = Some("account_limit".into());
            return Ok(paused);
        }
        let mut done = RunResult::new("run", "completed");
        done.final_message = Some(
            serde_json::from_value(json!({"ordinal": 2, "mid": "m2", "text": "the reply"}))
                .unwrap(),
        );
        Ok(done)
    }
}

/// llm-runner §12.1: "A runner that pauses the run itself (`paused` with an
/// account-limit reason) and continues it at the named time satisfies the
/// wait. The caller does nothing while it is paused." `paused` is not a
/// terminal state: the summarizer waits through it and reads the run's
/// later completion as its reply.
#[tokio::test]
async fn account_wait_review_a_run_the_runner_pauses_for_an_account_is_waited_for() {
    let client = PausingRunner {
        polls: Mutex::new(0),
    };
    let model = ModelRef::new("provider", "model");
    let how = run::Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1_000,
        system: "system",
        deadline: tokio::time::Instant::now() + std::time::Duration::from_secs(5),
        continuation: false,
        creates_child: true,
        keep_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        plan: None,
        send: SendKind::TurnOne,
    };
    let child = crate::client::Child {
        session: SessionRef::new("runner", "pi", "head:mc-summary:1-4:decision"),
        project_root: None,
    };
    match run::send_and_wait(&client, &child, "send", "prompt", &how, &mut None).await {
        Ok(reply) => assert_eq!(reply.text, "the reply"),
        Err(error) => panic!("the paused run was not waited for: {error}"),
    }
}
