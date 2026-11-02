//! Provider obligations of the compaction contract (CONTRACT.md in the
//! `cortexkit-role-compaction` crate) that ck-mc once broke, one test each.
//! They drive one session directly, over a runner that serves a fixed
//! transcript and applied view.

use cortexkit_role_compaction::notice::{Conditions, NoticeRequest};
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, SessionRef,
};
use cortexkit_role_compaction::ride::{RideCause, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{
    AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, Edit, EditOp, InsertAt, InsertedMessage,
    View, MAX_VIEW_BYTES,
};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::session::Session;
use serde_json::json;

/// A runner holding `entries` and applying `view`.
struct Fixed {
    entries: Vec<Entry>,
    view: Option<View>,
}

impl RunnerClient for Fixed {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        let mut head = Head::new();
        head.newest = self.entries.last().map(cursor);
        head.applied_view = self.view.as_ref().map(View::applied);
        Ok(ReadPage::new(self.entries.clone(), head))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.view.clone();
        Ok(answer)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError("no child runs here".into()))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError("no child runs here".into()))
    }
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

fn text(ordinal: u64, text: &str) -> Entry {
    let mut part = Part::new("t", PartBody::Text { text: text.into() });
    part.tag = Some(ordinal);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::User,
        ordinal,
        vec![part],
    )
}

fn rules() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn setup(fixed: &Fixed, context_window: u64) -> (Route, SetupRequest) {
    let route = Route {
        session: SessionRef::new("audit-runner", "mock", "audit"),
        project: None,
    };
    let mut request = SetupRequest::new(
        "worker",
        ModelRef::new("test", "initial"),
        context_window,
        1_000,
        rules(),
        vec![RideCause::OverLimit, RideCause::CacheExpired],
        1,
    );
    request.newest = fixed.entries.last().map(cursor);
    request.applied_view = fixed.view.as_ref().map(View::applied);
    (route, request)
}

fn conditions(request: &SetupRequest) -> Conditions {
    Conditions::new(
        request.model.clone(),
        request.context_window,
        request.output_reserve,
        request.rules.clone(),
    )
}

/// A notice numbered 0 is not newer than Setup's count (compaction contract N5), so it changes
/// nothing, here the session's model.
#[tokio::test]
async fn a_notice_numbered_zero_after_setup_is_ignored() {
    let fixed = Fixed {
        entries: vec![text(1, "task")],
        view: None,
    };
    let (route, request) = setup(&fixed, 10_000);
    let features = mc_module::preset::features("worker").unwrap();
    let settings = Settings::default();
    let mut session = Session::new(&route, &request, features, None);
    session
        .setup(&fixed, &settings, &route, &request, features)
        .await;
    let mut changed = conditions(&request);
    changed.model = ModelRef::new("test", "must-be-ignored");
    session
        .notice(
            &fixed,
            &settings,
            NoticeRequest::new(0, cursor(&fixed.entries[0]), changed),
        )
        .await;
    assert_eq!(session.config_inputs().1, "test/initial");
}

/// A view in a ride's answer is held to the same 3 MiB limit as a pushed one
/// (compaction contract V5): one byte under it applied, a queued drop pushes the next view over,
/// and the ride answers nothing rather than send it.
#[tokio::test]
async fn a_ride_never_answers_with_a_view_over_the_size_limit() {
    let prior_with = |text: String| {
        View::seal(
            1,
            vec![Edit::new(
                1,
                EditOp::Insert {
                    at: InsertAt::Start,
                    message: InsertedMessage::new("head", Role::User, vec![text]),
                },
            )],
        )
    };
    let overhead = serde_json::to_vec(&prior_with(String::new()))
        .unwrap()
        .len();
    let prior = prior_with("x".repeat(MAX_VIEW_BYTES - overhead - 1));
    assert_eq!(
        serde_json::to_vec(&prior).unwrap().len(),
        MAX_VIEW_BYTES - 1
    );

    let output = "y".repeat(40_000);
    let mut tool: Part = serde_json::from_value(json!({
        "id": "tool", "kind": "tool", "call_id": "c", "name": "read", "input": {},
        "status": "completed", "output": output, "output_bytes": 40_000, "digest": "",
    }))
    .unwrap();
    tool.tag = Some(2);
    let tool = Entry::new(2, "m2", Role::Assistant, 2, vec![tool]);
    let fixed = Fixed {
        entries: vec![text(1, "task"), tool, text(3, "next")],
        view: Some(prior),
    };
    let (route, request) = setup(&fixed, 1_000_000);
    let features = mc_module::preset::features("worker").unwrap();
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let mut session = Session::new(&route, &request, features, None);
    session
        .setup(&fixed, &settings, &route, &request, features)
        .await;
    session
        .tool(&fixed, &settings, "ctx_reduce", &json!({"drop": "2"}))
        .await
        .unwrap();
    let answer = session.ride(
        &settings,
        &RideRequest::new(vec![RideCause::CacheExpired], 1_000, conditions(&request)),
    );
    let size = answer.map(|view| serde_json::to_vec(&view).unwrap().len());
    assert!(
        size.is_none_or(|size| size <= MAX_VIEW_BYTES),
        "the ride answered a view of {size:?} bytes"
    );
}
