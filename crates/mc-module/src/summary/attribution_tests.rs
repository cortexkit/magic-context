//! Every child session a summary run creates is attributed before its first
//! model call: the fact is in the store when the runner receives the send
//! that creates the child, and a later send to the same child (a reattach,
//! or the second turn) adds nothing and changes nothing.

use super::*;
use crate::client::ClientError;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::FinalMessage;
use cortexkit_role_llm_runner::send::SendReply;
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use std::sync::Mutex;

/// A runner that answers every send with a valid first-turn reply, and
/// notes for each send whether the store held its child's fact when the
/// send arrived. Routing offers one model under one decision.
struct Client {
    runner: account_wait_send_tests::Client,
    db: Arc<ContextDb>,
    /// Each send's child, and the fact stored for it when the send arrived.
    seen: Mutex<Vec<(SessionRef, Option<Value>)>>,
    last_prompt: Mutex<String>,
}

impl Client {
    fn new(db: &Arc<ContextDb>) -> Self {
        Self {
            runner: account_wait_send_tests::Client::new(
                account_wait_send_tests::Answer::RefuseSend,
            ),
            db: Arc::clone(db),
            seen: Mutex::new(Vec::new()),
            last_prompt: Mutex::new(String::new()),
        }
    }
}

/// The fact stored for `child`, as JSON.
fn fact_of(db: &ContextDb, child: &SessionRef) -> Option<Value> {
    db.with_connection(|conn| {
        conn.query_row(
            "SELECT body FROM attribution_facts WHERE fact_id = ?1",
            [crate::attribution::fact_id(child)],
            |row| row.get::<_, String>(0),
        )
        .ok()
    })
    .map(|body| serde_json::from_str(&body).unwrap())
}

/// Every stored fact's place and body, oldest first.
fn stored(db: &ContextDb) -> Vec<(i64, String)> {
    db.with_connection(|conn| {
        conn.prepare("SELECT seq, body FROM attribution_facts ORDER BY seq")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    })
}

impl RunnerClient for Client {
    async fn read(
        &self,
        session: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, ClientError> {
        self.runner.read(session, request).await
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.seen
            .lock()
            .unwrap()
            .push((child.session.clone(), fact_of(&self.db, &child.session)));
        *self.last_prompt.lock().unwrap() = request.prompt.unwrap_or_default();
        let mut reply = SendReply::new(states::ACTIVE);
        reply.run_id = Some("run".into());
        Ok(reply)
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        let prompt = self.last_prompt.lock().unwrap().clone();
        let mut result = RunResult::new("run", states::COMPLETED);
        result.final_message = Some(FinalMessage {
            ordinal: 1,
            mid: "answer".into(),
            text: mc_mock_runner::child::turn_one_reply(&mc_mock_runner::child::summarize(&prompt)),
        });
        Ok(result)
    }
}

impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, routing::RouteError> {
        let route = RouteRef::new("test", "model");
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        Ok(SelectAnswer::new(
            "decision",
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }
    async fn report(&self, request: ReportRequest) {
        self.runner.report(request).await;
    }
}

fn store() -> (tempfile::TempDir, Arc<ContextDb>) {
    let dir = tempfile::tempdir().unwrap();
    let db = Arc::new(ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap());
    (dir, db)
}

#[tokio::test]
async fn a_summary_child_is_attributed_before_its_first_send() {
    let (_dir, db) = store();
    let client = Client::new(&db);
    let mut job = account_wait_send_tests::job();
    job.project = Some("pj-attributed".into());
    job.agent_id = Some("agent_alfonso".into());
    job.child_harness = Some("opencode2".into());
    run(&client, Some(&*db), &job)
        .await
        .expect("the run succeeds")
        .expect("the run has messages to summarize");

    let seen = client.seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "one first-turn send");
    let (child, fact) = &seen[0];
    let fact = fact
        .as_ref()
        .expect("the child's fact was stored before its first send arrived");
    assert_eq!(
        *child,
        SessionRef::new("runner", "opencode2", child.session.clone())
    );
    assert!(child.session.starts_with("head:mc-summary:"));
    assert_eq!(fact["fact_id"], json!(crate::attribution::fact_id(child)));
    assert_eq!(fact["supersedes"], Value::Null);
    assert_eq!(
        fact["subject"],
        json!({"kind": "session", "runner": "runner", "harness": "opencode2", "session": child.session})
    );
    assert_eq!(
        fact["parent"],
        json!({"kind": "session", "runner": "runner", "harness": "pi", "session": "head"})
    );
    assert_eq!(fact["alfonso"], "agent_alfonso");
    assert_eq!(fact["workload"], "summary");
    assert_eq!(fact["task"], "magic-context.summary");
    assert_eq!(fact["project_id"], "pj-attributed");
    assert_eq!(fact["effective_from_ms"], fact["recorded_at_ms"]);
    assert_eq!(stored(&db).len(), 1);
}

/// A run without a store, as in tests, attributes nothing and still runs.
#[tokio::test]
async fn a_run_without_a_store_attributes_nothing() {
    let (_dir, db) = store();
    let client = Client::new(&db);
    run(&client, None, &account_wait_send_tests::job())
        .await
        .expect("the run succeeds")
        .expect("the run has messages to summarize");
    assert_eq!(client.seen.lock().unwrap().len(), 1);
    assert!(stored(&db).is_empty());
}

#[tokio::test]
async fn a_second_send_to_the_same_child_adds_no_fact_and_keeps_the_first() {
    let (_dir, db) = store();
    let client = Client::new(&db);
    let model = ModelRef::new("provider", "model");
    let head = SessionRef::new("runner", "pi", "head");
    let purpose = crate::attribution::Purpose::summary(&head, Some("agent_a"), Some("pj-a"));
    let child = Child {
        session: SessionRef::new("runner", "pi", "head:mc-summary:1-4:decision:turn-one"),
        project_root: None,
    };
    let mut how = Model {
        model: &model,
        decision_id: "decision",
        output_tokens: 1000,
        system: "system",
        deadline: tokio::time::Instant::now() + Duration::from_secs(5),
        continuation: false,
        creates_child: true,
        attribution: Some(crate::attribution::Attribution {
            db: &db,
            purpose: &purpose,
        }),
        keep_child: false,
        cache_ttl: cortexkit_role_llm_runner::cache::Ttl::Short,
        plan: None,
        send: SendKind::TurnOne,
    };
    send_and_wait(&client, &child, "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    let first = stored(&db);
    assert_eq!(first.len(), 1);
    // The creating send again, as after a lost answer: same child, same id.
    tokio::time::sleep(Duration::from_millis(5)).await;
    send_and_wait(&client, &child, "first", "prompt", &how, &mut None)
        .await
        .unwrap();
    // The second turn continues the child.
    how.continuation = true;
    how.creates_child = false;
    how.send = SendKind::TurnTwo;
    send_and_wait(&client, &child, "second", "follow-up", &how, &mut None)
        .await
        .unwrap();
    assert_eq!(client.seen.lock().unwrap().len(), 3);
    assert_eq!(
        stored(&db),
        first,
        "one fact, at its first place, unchanged"
    );
}
