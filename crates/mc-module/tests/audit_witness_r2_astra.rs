//! Regression tests for five defects found before ck-mc served runner-hosted
//! sessions:
//! - a restart before the first summary treated the head's baseline as ahead
//!   of context.db and rebuilt `m[0]` below the threshold;
//! - a requested drop of signed text was built as a replacement, which the
//!   view rules refuse, so the whole pass was lost;
//! - a memory older than the fold's newest that became eligible later
//!   (restored, newly shared) never reached `m[1]`;
//! - a cache-loss ride with no emergency batch left the emergency lane spent;
//! - `ctx_keep` left known opaque parts outside the kept set in place.
//!
//! Each test failed before its fix.

use std::sync::Mutex;

use cortexkit_role_compaction::notice::{Conditions, NoticeRequest};
use cortexkit_role_compaction::part::{Part, PartBody, Seal};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, SessionRef,
};
use cortexkit_role_compaction::ride::{RideCause, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, View};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::StoredMemory;
use mc_module::pass::Settings;
use mc_module::route::{Project, Route};
use mc_module::session::Session;
use mc_module::store::Store;
use mc_module::summary::head;
use serde_json::json;

// The fixed-transcript client follows tests/contract_audit.rs. Like the
// scenarios' HostClient, it records every offered view and exposes the view
// the runner applies; the published view library checks every accepted edit.
#[derive(Default)]
struct Fixed {
    entries: Mutex<Vec<Entry>>,
    view: Mutex<Option<View>>,
    offered: Mutex<Vec<View>>,
}

impl Fixed {
    fn current(&self) -> Option<View> {
        self.view.lock().unwrap().clone()
    }

    fn newest(&self) -> Option<Cursor> {
        self.entries.lock().unwrap().last().map(cursor)
    }
}

impl RunnerClient for Fixed {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        let mut head = Head::new();
        head.newest = self.newest();
        head.applied_view = self.current().as_ref().map(View::applied);
        Ok(ReadPage::new(self.entries.lock().unwrap().clone(), head))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        let mut current = self.view.lock().unwrap();
        cortexkit_compaction_view::render::check_carried(current.as_ref(), &request.view).unwrap();
        cortexkit_compaction_view::render::apply(&self.entries.lock().unwrap(), &request.view)
            .unwrap();
        self.offered.lock().unwrap().push(request.view.clone());
        *current = Some(request.view);
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.current();
        Ok(answer)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Ok(SendReply::new("pending"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no historian should run in this witness"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no historian should run in this witness"))
    }
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

fn user(ordinal: u64, text: &str) -> Entry {
    let mut part = Part::new("text", PartBody::Text { text: text.into() });
    part.tag = Some(ordinal);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::User,
        ordinal,
        vec![part],
    )
}

fn request(preset: &str) -> SetupRequest {
    SetupRequest::new(
        preset,
        ModelRef::new("test", "test-model"),
        21_000,
        1_000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![RideCause::OverLimit, RideCause::CacheExpired],
        1,
    )
}

fn conditions(setup: &SetupRequest, prompt: u64) -> Conditions {
    let mut conditions = Conditions::new(
        setup.model.clone(),
        setup.context_window,
        setup.output_reserve,
        setup.rules.clone(),
    );
    conditions.last_prompt_tokens = Some(prompt);
    conditions
}

fn route(project: Option<Project>) -> Route {
    Route {
        session: SessionRef::new("audit-runner", "mock", "audit"),
        project,
        workdir: None,
        agent_id: None,
    }
}

#[tokio::test]
async fn audit_restart_without_summaries_preserves_the_warm_head() {
    let root = tempfile::tempdir().unwrap();
    let docs = root.path().join("ARCHITECTURE.md");
    std::fs::write(&docs, "# Architecture\nFrozen project instructions.\n").unwrap();
    let route = route(Some(Project {
        id: "audit-project".into(),
        root: root.path().to_string_lossy().into_owned(),
    }));
    let runner = Fixed::default();
    let mut setup = request("head");
    let settings = Settings::default();
    let features = mc_module::preset::features("head").unwrap();
    let mut first = Session::new(&route, &setup, features, None);
    first
        .setup(&runner, &settings, &route, &setup, features)
        .await;
    let frozen = runner
        .current()
        .expect("a new head publishes its first view");
    assert!(serde_json::to_string(&frozen)
        .unwrap()
        .contains("Frozen project instructions"));

    let task = user(1, "Continue working without a cache-loss ride.");
    runner.entries.lock().unwrap().push(task.clone());
    let mut notice = NoticeRequest::new(1, conditions(&setup, 1_000));
    notice.newest = Some(cursor(&task));
    notice.entries = vec![task];
    notice.applied_view = Some(frozen.applied());
    assert!(first
        .notice(&runner, &settings, notice.clone())
        .await
        .is_none());
    assert_eq!(
        first.durable().baseline.as_ref().unwrap().through_sequence,
        -1
    );
    assert!(!first.durable().head_stale);

    let store = Store::open(&root.path().join("mode3.db")).unwrap();
    store.save(&route.session, &first.durable()).unwrap();
    std::fs::write(
        &docs,
        "# Architecture\nChanged docs wait for a natural fold.\n",
    )
    .unwrap();
    setup.newest = runner.newest();
    setup.applied_view = Some(frozen.applied());
    let mut restarted = Session::new(&route, &setup, features, None);
    restarted.restore(store.load(&route.session).unwrap());
    restarted
        .setup(&runner, &settings, &route, &setup, features)
        .await;
    notice.seq = 1;
    restarted.notice(&runner, &settings, notice).await;

    // Correct behavior retains the persisted no-summary baseline. Restarting
    // only ck-mc does not invalidate the runner's warm provider cache, and a
    // docs edit is not a fold trigger. No new view should be offered at 5%.
    assert_eq!(
        runner.current(),
        Some(frozen),
        "a provider-only restart refolded m[0] below execute"
    );
}

fn memory(id: i64, content: &str) -> StoredMemory {
    StoredMemory {
        id,
        project_path: "audit-project".into(),
        category: "CONSTRAINTS".into(),
        content: content.into(),
        status: "active".into(),
        importance: Some(70),
        ..StoredMemory::default()
    }
}

fn inputs(memories: &[StoredMemory]) -> head::Inputs<'_> {
    head::Inputs {
        counter: mc_module::count::Counter::for_model(None),
        summaries: &[],
        docs: "",
        profile: &[],
        profile_max_id: 0,
        memories,
        workspace: None,
        gone: &[],
        history_budget_tokens: 100_000,
        history_local_budget_tokens: 100_000,
        memory_budget_tokens: 8_000,
        profile_budget_tokens: 4_000,
    }
}

#[test]
fn audit_newly_eligible_older_memory_is_added_to_m1() {
    let initial = vec![memory(100, "A currently eligible constraint.")];
    let baseline = head::fold(&inputs(&initial), None);
    // A lower-id memory can enter the eligible pool after an archive restore,
    // workspace join or sharing change; it was not omitted for lack of budget.
    let current = vec![
        memory(
            7,
            "Restored constraint: never delete the production database.",
        ),
        initial[0].clone(),
    ];
    let (m1, next, _) = head::delta(&baseline, &inputs(&current));
    assert_eq!(next.m0, baseline.m0);
    // The newly eligible memory appears in m[1] on this refresh, without
    // waiting for the next m[0] rebuild and without changing m[0].
    assert!(
        m1.contains("Restored constraint"),
        "m[1] silently omitted a newly eligible lower-id memory: {m1}"
    );
}

fn tool_entry(ordinal: u64, tag: u64) -> Entry {
    let tool: Part = serde_json::from_value(json!({
        "id": "tool", "kind": "tool", "call_id": format!("c{tag}"),
        "name": "read", "input": {"path": format!("file-{tag}")},
        "status": "completed", "output": "x".repeat(10_000),
        "output_bytes": 10_000, "digest": ""
    }))
    .unwrap();
    let tool = Part::new("tool", tool.body).with_tag(tag);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::Assistant,
        tag,
        vec![tool],
    )
}

#[tokio::test]
async fn audit_cache_loss_rearms_emergency_when_no_batch_can_land_yet() {
    let runner = Fixed::default();
    let mut entries = vec![user(1, &"brief ".repeat(50_000))];
    entries.extend((2..=6).map(|ordinal| tool_entry(ordinal, ordinal)));
    *runner.entries.lock().unwrap() = entries.clone();
    let route = route(None);
    let mut setup = request("worker");
    setup.context_window = 101_000;
    setup.newest = runner.newest();
    let features = mc_module::preset::features("worker").unwrap();
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let mut session = Session::new(&route, &setup, features, None);
    session
        .setup(&runner, &settings, &route, &setup, features)
        .await;
    let mut notice = NoticeRequest::new(1, conditions(&setup, 90_000));
    notice.newest = runner.newest();
    notice.entries = entries;
    session.notice(&runner, &settings, notice.clone()).await;
    let first = runner.current().expect("the initial emergency batch lands");
    assert!(session.durable().emergency_latched);

    // Only the three protected calls remain, so a cold-cache ride cannot
    // select another batch. The cache loss must nevertheless rearm the latch.
    let mut ride = RideRequest::new(
        vec![RideCause::CacheExpired],
        1_000,
        conditions(&setup, 90_000),
    );
    ride.applied_view = Some(first.applied());
    assert!(session.ride(&settings, &ride).is_none());

    let new = tool_entry(7, 7);
    runner.entries.lock().unwrap().push(new.clone());
    notice.seq = 2;
    notice.newest = Some(cursor(&new));
    notice.entries = vec![new];
    notice.applied_view = Some(first.applied());
    session.notice(&runner, &settings, notice).await;
    // Correct behavior drops the now-unprotected 2,500-token result in a new
    // emergency batch. The previous cache-loss ride ended the spent episode.
    assert!(
        runner.current().unwrap().version > first.version,
        "the cache-loss ride left emergency reclaim latched"
    );
}

#[tokio::test]
async fn audit_signed_text_reduction_uses_a_legal_whole_part_drop() {
    let runner = Fixed::default();
    let signed = Part::new(
        "answer",
        PartBody::Text {
            text: "A finished signed answer.".into(),
        },
    )
    .with_tag(2)
    .with_seal(Seal::Signed);
    *runner.entries.lock().unwrap() = vec![
        user(1, "Preserve the worker's instructions."),
        Entry::new(2, "m2", Role::Assistant, 2, vec![signed]),
        user(3, "The earlier answer is no longer needed."),
    ];
    let route = route(None);
    let mut setup = request("worker");
    setup.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    setup.newest = runner.newest();
    let features = mc_module::preset::features("worker").unwrap();
    let settings = Settings::default();
    let mut session = Session::new(&route, &setup, features, None);
    session
        .setup(&runner, &settings, &route, &setup, features)
        .await;
    session
        .tool(&runner, &settings, "ctx_reduce", &json!({"drop": "2"}))
        .await
        .unwrap();
    let view = session.ride(
        &settings,
        &RideRequest::new(
            vec![RideCause::CacheExpired],
            1_000,
            conditions(&setup, 1_000),
        ),
    );
    // Signed text (including Gemini thought-signed text) may be dropped but
    // never replaced. Correct reduction emits a whole-part Drop rather than
    // rejecting the entire view because its placeholder modifies sealed bytes.
    let view = view.expect("a requested signed text outside the tail must have a legal drop view");
    assert!(view.edits.iter().any(|edit| matches!(
        &edit.op,
        cortexkit_role_compaction::view::EditOp::Drop { mid, part: Some(part) }
            if mid == "m2" && part == "answer"
    )));
}

#[tokio::test]
async fn audit_ctx_keep_drops_known_opaque_content_outside_the_kept_set() {
    let runner = Fixed::default();
    let opaque: Part = serde_json::from_value(json!({
        "id": "custom", "kind": "opaque", "provider_kind": "anthropic.compaction",
        "size": 10_000, "digest": ""
    }))
    .unwrap();
    let opaque = Part::new("custom", opaque.body);
    let mut keep = tool_entry(3, 2);
    if let PartBody::Tool(tool) = &mut keep.parts[0].body {
        tool.name = "ctx_keep".into();
        tool.input = json!({"tags": "1", "note": "Only the instructions are needed."});
    }
    keep.parts[0] = Part::new("tool", keep.parts[0].body.clone()).with_tag(2);
    keep = Entry::new(3, "m3", Role::Assistant, 2, keep.parts);
    *runner.entries.lock().unwrap() = vec![
        user(1, "The worker's instructions."),
        Entry::new(2, "m2", Role::Assistant, 2, vec![opaque]),
        keep,
    ];
    let route = route(None);
    let mut setup = request("worker");
    setup.newest = runner.newest();
    let features = mc_module::preset::features("worker").unwrap();
    let settings = Settings::default();
    let mut session = Session::new(&route, &setup, features, None);
    session
        .setup(&runner, &settings, &route, &setup, features)
        .await;
    session
        .tool(
            &runner,
            &settings,
            "ctx_keep",
            &json!({"tags": "1", "note": "Only the instructions are needed."}),
        )
        .await
        .unwrap();
    let view = session.ride(
        &settings,
        &RideRequest::new(
            vec![RideCause::CacheExpired],
            1_000,
            conditions(&setup, 1_000),
        ),
    );
    // The known opaque kind is drop-only, not an unknown kind that must be
    // carried unchanged. Correct ctx_keep removes it with the other unkept
    // assistant content and therefore returns a view even below execute.
    let view = view.expect("ctx_keep must remove the unkept opaque part");
    assert!(view.edits.iter().any(|edit| matches!(
        &edit.op,
        cortexkit_role_compaction::view::EditOp::Drop { mid, part: Some(part) }
            if mid == "m2" && part == "custom"
    )));
}
