//! Regression tests for four defects found before mode 3 went live:
//! - the age sweep dropped outputs in the protected tail;
//! - on a `ctx_keep` pass, other lanes dropped parts the model chose to keep;
//! - a history head kept as shown, after a read it needs failed, still
//!   moved the cut, hiding messages without their summary;
//! - after adopting a newer view from the runner, the next pass re-rendered
//!   `m[0]` from ck-mc's older baseline.
//!
//! Each test failed before its fix. The runner adapter follows
//! `contract_audit.rs`; transcript numbering and paged reads reuse the same
//! mock `Transcript` as the scenario harness.

use std::sync::{Arc, Mutex};

use cortexkit_role_compaction::notice::{Conditions, NoticeRequest};
use cortexkit_role_compaction::part::{PartBody, Seal};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, ReadRequest, Role, SessionRef};
use cortexkit_role_compaction::ride::{RideCause, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, EditOp, View,
};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use mc_mock_runner::transcript::Transcript;
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::session::Session;
use serde_json::json;

struct AuditRunner {
    transcript: Transcript,
    applied: Mutex<Option<View>>,
}

impl AuditRunner {
    fn new(transcript: Transcript) -> Self {
        Self {
            transcript,
            applied: Mutex::new(None),
        }
    }

    fn view(&self) -> Option<View> {
        self.applied.lock().unwrap().clone()
    }
}

impl RunnerClient for AuditRunner {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let (entries, next) = self
            .transcript
            .read(&request.select, request.detail, request.max_bytes)
            .map_err(|error| ClientError::new(format!("{error:?}")))?;
        let mut head = Head::new();
        head.newest = self.transcript.cursor();
        head.applied_view = self.view().as_ref().map(View::applied);
        let mut page = ReadPage::new(entries, head);
        page.next_after = next;
        Ok(page)
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        cortexkit_compaction_view::render::apply(self.transcript.entries(), &request.view)
            .expect("the witness runner must be able to apply the offered view");
        *self.applied.lock().unwrap() = Some(request.view);
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.view();
        Ok(answer)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("audit-reminder"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no model runs in these witnesses"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no model runs in these witnesses"))
    }
}

fn append(transcript: &mut Transcript, role: Role, body: PartBody) -> Entry {
    transcript
        .append(role, None, vec![(Seal::None, body)], None, None, 1)
        .clone()
}

fn person(transcript: &mut Transcript, text: &str) -> Entry {
    append(transcript, Role::User, PartBody::Text { text: text.into() })
}

fn tool(transcript: &mut Transcript, name: &str, output: &str) -> Entry {
    let id = transcript.entries().len();
    append(
        transcript,
        Role::Assistant,
        serde_json::from_value(json!({
            "kind": "tool", "call_id": format!("call-{id}"), "name": name,
            "input": {"path": format!("file-{id}.rs")}, "status": "completed",
            "output": output, "output_bytes": output.len()
        }))
        .unwrap(),
    )
}

fn conditions() -> Conditions {
    Conditions::new(
        ModelRef::new("test", "audit"),
        101_000,
        1_000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
    )
}

fn setup(runner: &AuditRunner, preset: &str) -> (Route, SetupRequest) {
    let conditions = conditions();
    let route = Route {
        session: SessionRef::new("audit-runner", "mock", "audit"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let mut request = SetupRequest::new(
        preset,
        conditions.model,
        conditions.context_window,
        conditions.output_reserve,
        conditions.rules,
        vec![RideCause::CacheExpired, RideCause::OverLimit],
        1,
    );
    request.newest = runner.transcript.cursor();
    request.applied_view = runner.view().as_ref().map(View::applied);
    (route, request)
}

async fn enroll(
    runner: &AuditRunner,
    preset: &str,
    settings: &Settings,
    db: Option<Arc<ContextDb>>,
) -> Session {
    let (route, request) = setup(runner, preset);
    let features = mc_module::preset::features(preset).unwrap();
    let mut session = Session::new(&route, &request, features, db);
    session
        .setup(runner, settings, &route, &request, features)
        .await;
    session
}

async fn cold_ride(
    session: &mut Session,
    runner: &AuditRunner,
    settings: &Settings,
) -> Option<View> {
    let mut ride = RideRequest::new(vec![RideCause::CacheExpired], 1_000, conditions());
    ride.applied_view = runner.view().as_ref().map(View::applied);
    let answer = session.ride(settings, &ride);
    if let Some(view) = &answer {
        runner
            .apply_view(session.key(), ApplyViewRequest::new(view.clone()))
            .await
            .unwrap();
    }
    answer
}

fn changes_part(view: &View, entry: &Entry) -> bool {
    view.edits.iter().any(|edit| match &edit.op {
        EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => *mid == entry.mid,
        _ => false,
    })
}

#[tokio::test]
async fn audit_age_sweep_must_keep_the_protected_tail() {
    let mut transcript = Transcript::new(0);
    person(&mut transcript, "Keep working on the implementation.");
    let read = tool(
        &mut transcript,
        "read",
        &"important source code\n".repeat(200),
    );
    for prompt in [
        "Explain it",
        "Check the invariants",
        "Continue using that source",
    ] {
        person(&mut transcript, prompt);
    }
    let runner = AuditRunner::new(transcript);
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let mut session = enroll(&runner, "worker", &settings, None).await;
    assert!(cold_ride(&mut session, &runner, &settings).await.is_none());
    let second = cold_ride(&mut session, &runner, &settings).await;
    // Correct behavior keeps the sole tool call: three newer user turns make
    // it distant, but do not remove the minimum three-call tail protection.
    assert!(
        second
            .as_ref()
            .is_none_or(|view| !changes_part(view, &read)),
        "age sweep changed the sole, still-protected tool call: {second:?}"
    );
}

#[tokio::test]
async fn audit_ctx_keep_must_win_over_automatic_age_reclaim() {
    let mut transcript = Transcript::new(0);
    person(&mut transcript, "Implement the change.");
    let needed = tool(
        &mut transcript,
        "read",
        &"source still needed\n".repeat(200),
    );
    for _ in 0..3 {
        tool(&mut transcript, "read", "short result");
    }
    for prompt in [
        "Explain it",
        "Check it",
        "Keep the source for the next edit",
    ] {
        person(&mut transcript, prompt);
    }
    tool(&mut transcript, "ctx_keep", "keeping the selected source");
    let runner = AuditRunner::new(transcript);
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let mut session = enroll(&runner, "worker", &settings, None).await;
    assert!(cold_ride(&mut session, &runner, &settings).await.is_none());
    let tag = needed.parts[0].tag.unwrap();
    let answer = session
        .tool(
            &runner,
            &settings,
            "ctx_keep",
            &json!({
                "tags": tag.to_string(), "note": "The next edit requires this exact source."
            }),
        )
        .await
        .unwrap();
    assert!(answer.starts_with(&format!("Keeping §{tag}§")), "{answer}");
    let view = cold_ride(&mut session, &runner, &settings).await.unwrap();
    // Correct behavior excludes explicitly kept parts from every other lane
    // in the same pass, not just from keep_drops itself.
    assert!(
        !changes_part(&view, &needed),
        "ctx_keep promised {answer}, but emitted {view:?}"
    );
}

fn database() -> (tempfile::TempDir, Arc<ContextDb>) {
    let scratch = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    let directory = tempfile::Builder::new()
        .prefix("audit-")
        .tempdir_in(scratch)
        .unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&directory.path().join("context.db")).unwrap());
    (directory, db)
}

fn history() -> Transcript {
    let mut transcript = Transcript::new(0);
    for prompt in [
        "The API must preserve the original tenant boundary.",
        "We verified the tenant tests.",
        "Use the validated tenant ID, never a guessed one.",
        "Now implement the next endpoint.",
        "Keep the remaining work raw.",
        "Continue.",
    ] {
        person(&mut transcript, prompt);
    }
    transcript
}

// Same stored-summary fixture as scenarios.rs::insert_summary, using the
// mock runner's actual endpoint identities rather than deriving them.
fn insert_summary(db: &ContextDb, runner: &AuditRunner) {
    let entries = runner.transcript.entries();
    db.with_connection(|connection| {
        connection
            .execute(
                "INSERT INTO compartments (session_id, sequence, start_message, end_message,
                 start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('audit', 0, 1, 3, ?1, ?2, 'Tenant boundary', ?3, ?3, 1, 'mock')",
                rusqlite::params![
                    entries[0].mid,
                    entries[2].mid,
                    "Tenant boundary verified: never guess the tenant ID."
                ],
            )
            .unwrap();
    });
}

fn m0(view: &View) -> String {
    view.edits
        .iter()
        .find_map(|edit| match &edit.op {
            EditOp::Insert { message, .. } if message.id == "magic-context:m0" => {
                Some(message.texts.join("\n"))
            }
            _ => None,
        })
        .expect("the head view has m[0]")
}

async fn execute_notice(session: &mut Session, runner: &AuditRunner, settings: &Settings) {
    let mut conditions = conditions();
    conditions.last_prompt_tokens = Some(65_000);
    let mut notice = NoticeRequest::new(1, conditions);
    notice.newest = runner.transcript.cursor();
    notice.applied_view = runner.view().as_ref().map(View::applied);
    notice.entries = runner.transcript.entries().to_vec();
    let summary = session.notice(runner, settings, notice).await;
    assert!(
        summary.is_none(),
        "the small transcript cannot start a historian run"
    );
}

#[tokio::test]
async fn audit_failed_head_read_must_not_advance_the_cut() {
    let (_directory, db) = database();
    let runner = AuditRunner::new(history());
    let settings = Settings::default();
    let mut session = enroll(&runner, "head", &settings, Some(db.clone())).await;
    let initial = cold_ride(&mut session, &runner, &settings).await.unwrap();
    assert!(!m0(&initial).contains("Tenant boundary verified"));
    insert_summary(&db, &runner);
    session.load_summaries();
    // Fault only the profile query after the new summary has been loaded.
    // This deterministically exercises the same read-error branch as a failed
    // shared-store read, without touching any real store or deleting data.
    db.with_connection(|connection| {
        connection
            .execute_batch("ALTER TABLE user_memories RENAME TO unavailable_user_memories;")
            .unwrap()
    });
    let answer = cold_ride(&mut session, &runner, &settings).await;
    let cut = answer.as_ref().and_then(|view| {
        view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(through.clone()),
            _ => None,
        })
    });
    // Correct behavior keeps the old cut with the old head. Otherwise the
    // runner omits the raw messages without receiving their new summary.
    assert!(
        cut.is_none(),
        "head rendering failed but the view cut through {cut:?}; head={:?}",
        answer.as_ref().map(m0)
    );
}

#[tokio::test]
async fn audit_adopting_a_newer_view_must_preserve_its_frozen_m0() {
    let (_directory, db) = database();
    let runner = AuditRunner::new(history());
    let settings = Settings::default();
    let mut authoritative = enroll(&runner, "head", &settings, Some(db.clone())).await;
    cold_ride(&mut authoritative, &runner, &settings)
        .await
        .unwrap();
    // Confirm the first view so this saved snapshot contains no pending
    // publication. It predates the later fold that the runner still has.
    execute_notice(&mut authoritative, &runner, &settings).await;
    let older_store = authoritative.durable();
    insert_summary(&db, &runner);
    authoritative.load_summaries();
    let newer = cold_ride(&mut authoritative, &runner, &settings)
        .await
        .unwrap();
    let frozen = m0(&newer);
    assert!(frozen.contains("Tenant boundary verified"));

    let (route, request) = setup(&runner, "head");
    let features = mc_module::preset::features("head").unwrap();
    let mut restored = Session::new(&route, &request, features, Some(db));
    restored.load_summaries();
    restored.restore(older_store);
    restored
        .setup(&runner, &settings, &route, &request, features)
        .await;
    assert_eq!(restored.durable().version, newer.version);
    execute_notice(&mut restored, &runner, &settings).await;
    // Correct behavior adopts the served head, not just the view version.
    // A warm execute with no new content must not undo the runner's fold.
    assert_eq!(
        m0(&runner.view().unwrap()),
        frozen,
        "adopting the runner's view left an older baseline that rewrote m[0]"
    );
}
