use super::*;
use crate::dream_dispatch::{
    broca_carrier::{BrocaPort, BrocaToolRoute, PortError},
    context::{Cancellation, CapturedConfig, Clock},
    dispatcher::{DispatchOutcome, Dispatcher, GateDecision, TaskExecutor, OPERATIONAL_TASKS},
    executor::{BrocaPorts, DreamExecutor, Transport},
};
use cortexkit_role_llm_runner::{
    describe::{Major, RoleDescribe},
    run::{FinalMessage, RunResult, RunStatus as WireStatus},
};
use mc_store::{
    dream_scheduler::{
        schedules::{RunOutcome, RunStatus, TaskConfig},
        SqliteDreamScheduler,
    },
    parity_schema_manifest::*,
};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicI64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use crate::model_work::tests::kit_fake;

struct IdleWire {
    route: kit_fake::FakeRoute,
    selects: AtomicUsize,
    runner_routes: AtomicUsize,
    sends: AtomicUsize,
}

#[subc_client_rs::async_trait]
impl crate::dream_dispatch::routed::wire::DreamWire for IdleWire {
    fn scope_support(&self) -> Result<(), crate::dream_dispatch::routed::wire::WireRefusal> {
        Ok(())
    }
    async fn lookup_project(
        &self,
        _: &Path,
    ) -> Option<crate::dream_dispatch::routed::scope::EntorhinalProjectId> {
        unreachable!("idle gate must precede scope work")
    }
    async fn sync_scope(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
    ) -> Result<(), crate::dream_dispatch::routed::wire::WireRefusal> {
        Ok(())
    }
    async fn end_scope(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
    ) -> Result<(), crate::dream_dispatch::routed::wire::WireRefusal> {
        Ok(())
    }
    async fn routing_catalog(&self) -> crate::model_work::RoutingCatalog {
        crate::model_work::RoutingCatalog {
            generation: 1,
            providers: vec!["fake-routing".into()],
        }
    }
    async fn tool_providers(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &[&str],
    ) -> Result<
        Vec<crate::dream_dispatch::routed::fetch_plan::Provider>,
        crate::dream_dispatch::routed::wire::WireRefusal,
    > {
        Ok(vec![])
    }
    async fn select(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &str,
        request: &cortexkit_role_routing::select::SelectRequest,
    ) -> Result<Value, cortexkit_role_routing::errors::Refusal> {
        use cortexkit_role_routing_conformance::{Reply, RoutingRoute};
        self.selects.fetch_add(1, Ordering::SeqCst);
        match self
            .route
            .request("route.select", &serde_json::to_value(request).unwrap())
            .await
            .unwrap()
        {
            Reply::Response(text) => {
                Ok(serde_json::from_str::<Value>(&text).unwrap()["result"].clone())
            }
            Reply::Error(error) => {
                Err(serde_json::from_value(serde_json::to_value(error).unwrap()).unwrap())
            }
        }
    }
    async fn report(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &str,
        _: &cortexkit_role_routing::report::ReportRequest,
    ) -> Result<cortexkit_role_routing::report::ReportAnswer, cortexkit_role_routing::errors::Refusal>
    {
        unreachable!("idle gate must precede report")
    }
    async fn runner_call(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &crate::dream_dispatch::routed::wire::RunnerBind,
        op: &str,
        _: Value,
    ) -> Result<Value, PortError> {
        self.runner_routes.fetch_add(1, Ordering::SeqCst);
        if op == "session.send" {
            self.sends.fetch_add(1, Ordering::SeqCst);
        }
        unreachable!("idle gate must precede runner routing")
    }
    async fn runner_next_unit(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &crate::dream_dispatch::routed::wire::RunnerBind,
    ) -> Result<Option<Value>, PortError> {
        unreachable!("idle gate must precede subscribe")
    }
    async fn runner_release(
        &self,
        _: &crate::dream_dispatch::routed::scope::DreamScope,
        _: &crate::dream_dispatch::routed::wire::RunnerBind,
    ) {
    }
}

struct TestClock(AtomicI64);
impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct Source {
    calls: AtomicUsize,
    pin: Mutex<MemoryContext>,
    store: Arc<McStore>,
    scheduler: Arc<SqliteDreamScheduler>,
    folder: std::path::PathBuf,
}
impl ProjectProfiles for Source {
    fn read<'a>(
        &'a self,
        folder: &'a str,
    ) -> Pin<Box<dyn Future<Output = MemoryContext> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(Path::new(folder), self.folder);
            self.calls.fetch_add(1, Ordering::SeqCst);
            // Both stores must remain writable while the context read awaits.
            self.store
                .with_context_conn_for_test(|db| {
                    db.execute_batch(
                        "INSERT OR IGNORE INTO project_state(project_path) VALUES('reader')",
                    )
                })
                .unwrap();
            self.scheduler
                .set_target_project_id("reader", "project-id")
                .unwrap();
            tokio::task::yield_now().await;
            self.pin.lock().unwrap().clone()
        })
    }
}

#[derive(Default)]
struct Script {
    sends: usize,
    routes: usize,
    writes: Vec<Value>,
    text: String,
    edit: Option<(std::path::PathBuf, String)>,
    clock_jump: Option<(Arc<TestClock>, i64)>,
}
#[derive(Clone)]
struct FakePort {
    script: Arc<Mutex<Script>>,
    tools: Arc<BrocaToolRoute>,
    root: std::path::PathBuf,
}
impl BrocaPorts for FakePort {
    type Port = Self;
    fn port(&self) -> Self {
        self.clone()
    }
}
impl BrocaPort for FakePort {
    async fn call(&mut self, session: &str, op: &str, _: Value) -> Result<Value, PortError> {
        let reply = match op {
            "role.describe" => {
                self.script.lock().unwrap().routes += 1;
                serde_json::to_value(
                    RoleDescribe::new(
                        vec![Major::new(
                            "llm-runner/v1",
                            [
                                "role.describe",
                                "session.baseline",
                                "session.send",
                                "session.read",
                                "run.result",
                                "run.status",
                                "run.cancel",
                                "session.retract",
                                "session.subscribe",
                            ]
                            .map(str::to_owned)
                            .to_vec(),
                            "stable",
                        )],
                        "fake",
                    )
                    .with_capabilities(
                        [
                            "queue",
                            "run_ops",
                            "run_status",
                            "streaming",
                            "retention",
                            "plans",
                            "run_cancel",
                            "retract",
                            "max_steps",
                            "no_tools",
                        ]
                        .map(str::to_owned)
                        .to_vec(),
                    )
                    .with_session_capabilities_from("admission")
                    .with_retention(1_000_000, 600_000)
                    .with_run_cancel(vec!["now".into(), "step_boundary".into()]),
                )
                .unwrap()
            }
            "session.send" => {
                let (mut writes, edit, clock_jump) = {
                    let mut s = self.script.lock().unwrap();
                    s.sends += 1;
                    (
                        std::mem::take(&mut s.writes),
                        s.edit.take(),
                        s.clock_jump.take(),
                    )
                };
                if let Some((clock, now)) = clock_jump {
                    clock.0.store(now, Ordering::SeqCst);
                }
                if let Some((path, content)) = edit {
                    std::fs::write(path, content).unwrap();
                }
                // Curation's result validator counts updates, merges and archives,
                // not creates. Pair a requested create with a completed update.
                if writes.iter().any(|call| call["action"] == "write") {
                    writes.push(
                        json!({"action":"update","ids":[1],"content":"Updated existing fact."}),
                    );
                }
                for (n, arguments) in writes.into_iter().enumerate() {
                    let reply=self.tools.call(session, &self.root, &json!({"name":"ctx_memory","arguments":arguments,"call_key":format!("lineage-1:{}",n+1)})).unwrap();
                    assert_eq!(reply["ok"], true, "{reply}");
                    assert!(
                        !reply["output"]
                            .as_str()
                            .unwrap_or_default()
                            .starts_with("Error:"),
                        "{reply}"
                    );
                }
                json!({"state":"active","run_id":"run"})
            }
            "run.status" => serde_json::to_value(WireStatus::new("completed")).unwrap(),
            "run.result" => serde_json::to_value(
                RunResult::new("run", "completed").with_final_message(FinalMessage {
                    ordinal: 1,
                    mid: "m1".into(),
                    text: self.script.lock().unwrap().text.clone(),
                }),
            )
            .unwrap(),
            "session.baseline" => json!({"last_ordinal":0}),
            other => panic!("unexpected runner op {other}"),
        };
        Ok(json!({"result":reply}))
    }
    async fn next_unit(&mut self, _: &str) -> Result<Option<Value>, PortError> {
        Ok(None)
    }
    async fn release(&mut self, _: &str) {}
}

struct Rig {
    _dir: tempfile::TempDir,
    dispatcher: Dispatcher<DreamExecutor<FakePort>>,
    clock: Arc<TestClock>,
    script: Arc<Mutex<Script>>,
    source: Arc<Source>,
}
impl Rig {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute_batch(
                &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                    .replace(":applied_at", "1"),
            )
            .unwrap();
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(dir.path().to_str().unwrap()))
                .unwrap(),
        );
        let scheduler =
            Arc::new(SqliteDreamScheduler::open(dir.path().join("scheduler.db"), true).unwrap());
        let root = dir.path().canonicalize().unwrap();
        let scope = StoreScope {
            project: ProjectId(root.to_string_lossy().into_owned()),
            session: SessionId("parent".into()),
            generation: Generation(1),
        };
        let source = Arc::new(Source {
            calls: AtomicUsize::new(0),
            pin: Mutex::new(unavailable_context()),
            folder: root.clone(),
            store: store.clone(),
            scheduler: scheduler.clone(),
        });
        let tools = crate::McHandler::new().broca_dream_tools();
        let script = Arc::new(Mutex::new(Script {
            text: "No further changes.".into(),
            ..Default::default()
        }));
        let port = FakePort {
            script: script.clone(),
            tools: tools.clone(),
            root: root.clone(),
        };
        let executor = DreamExecutor::new(
            store.clone(),
            scheduler.clone(),
            Transport::Broca {
                ports: port,
                routes: tools,
                module_id: "magic-context".into(),
            },
            OPERATIONAL_TASKS,
            OPERATIONAL_TASKS,
        )
        .with_project_context(source.clone(), root.clone(), "opencode");
        let clock = Arc::new(TestClock(AtomicI64::new(60_000)));
        let dispatcher = Dispatcher {
            store,
            scheduler,
            scope,
            clock: clock.clone(),
            config: Arc::new(CapturedConfig {
                activated: true,
                route: crate::McModuleConfig {
                    rust_background_enabled: true,
                    dreamer_runner: Some(crate::HistorianRunnerKind::Broca),
                    ..Default::default()
                },
                effective: json!({"dreamer":{"opencode":{"model":"provider/model"}}}),
                harness: "opencode".into(),
                directory: root,
            }),
            executor,
        };
        let rig = Self {
            _dir: dir,
            dispatcher,
            clock,
            script,
            source,
        };
        rig.sql("INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(1,?1,'ARCHITECTURE','Original fact.','normalized',50,'project',0,'active',1,1,1,1)");
        rig.dispatcher
            .store
            .with_context_conn_for_test(|db| {
                db.execute(
                    "UPDATE memories SET normalized_hash=?1 WHERE id=1",
                    [mc_store::compute_normalized_memory_hash("Original fact.")],
                )?;
                Ok(())
            })
            .unwrap();
        rig
    }
    fn sql(&self, sql: &str) {
        self.dispatcher
            .store
            .with_context_conn_for_test(|db| {
                let mut statement = db.prepare(sql)?;
                if statement.parameter_count() == 0 {
                    statement.execute([])?;
                } else {
                    statement.execute([&self.dispatcher.scope.project.0])?;
                }
                Ok(())
            })
            .unwrap();
    }
    fn inputs(&self, task: TaskName) -> Inputs {
        capture(
            &self.dispatcher.store,
            &self.dispatcher.scope.project.0,
            &self.dispatcher.config.directory,
            &self.dispatcher.config.harness,
            task,
        )
        .unwrap()
    }
    fn config(task: TaskName) -> TaskConfig {
        TaskConfig {
            task,
            schedule: "* * * * *".into(),
            has_input: true,
            legacy_last_run_at: None,
        }
    }
    fn state(&self, task: TaskName) -> ScheduleState {
        match self
            .dispatcher
            .scheduler
            .schedule(&self.dispatcher.scope, task)
        {
            CapabilityResult::Available { value: Some(state) } => state,
            other => panic!("{other:?}"),
        }
    }
    fn seed(&self, task: TaskName) {
        self.dispatcher
            .scheduler
            .plan_due(
                &self.dispatcher.scope,
                &[Self::config(task)],
                self.clock.now_ms(),
                true,
            )
            .available();
        let mut state = self.state(task);
        state.inputs_watermark = Some(self.inputs(task).watermark());
        state.last_run_at = Some(1);
        self.save(task, &state);
    }
    fn save(&self, task: TaskName, state: &ScheduleState) {
        rusqlite::Connection::open(self._dir.path().join("scheduler.db"))
            .unwrap()
            .execute(
                "UPDATE dream_schedules SET state=?1 WHERE project=?2 AND task=?3",
                rusqlite::params![
                    serde_json::to_string(state).unwrap(),
                    self.dispatcher.scope.project.0,
                    task.as_str()
                ],
            )
            .unwrap();
    }
    async fn slot(&mut self, task: TaskName) -> DispatchOutcome {
        let state = self.state(task);
        self.clock
            .0
            .store(state.next_due_at.unwrap(), Ordering::SeqCst);
        let outcome = self
            .dispatcher
            .tick(&[Self::config(task)], true, Duration::from_secs(30 * 60))
            .await
            .unwrap()
            .pop()
            .unwrap()
            .1;
        outcome
    }
}

trait Available<T> {
    fn available(self) -> T;
}
impl<T: std::fmt::Debug> Available<T> for CapabilityResult<T> {
    fn available(self) -> T {
        match self {
            Self::Available { value } => value,
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn idle_slots_skip_before_transport() {
    use cortexkit_role_routing_conformance::{RouteStamp, RoutingSubject};
    let mut rig = Rig::new();
    let fake = kit_fake::FakeSubject::new(kit_fake::Defects::default());
    let wire = Arc::new(IdleWire {
        route: fake
            .route(&RouteStamp::project("magic-context", "served-project"))
            .await
            .unwrap(),
        selects: AtomicUsize::new(0),
        runner_routes: AtomicUsize::new(0),
        sends: AtomicUsize::new(0),
    });
    rig.dispatcher.executor.transport = Transport::Routed {
        wire: wire.clone(),
        routes: crate::McHandler::new().broca_dream_tools(),
        module_id: "magic-context".into(),
        project_id: crate::dream_dispatch::routed::scope::EntorhinalProjectId::from_lookup_answer(
            "pj-11111111111111111111111111111111",
        )
        .unwrap(),
        parks: Arc::default(),
    };
    for &task in OPERATIONAL_TASKS {
        rig.seed(task);
    }
    for &task in OPERATIONAL_TASKS {
        let before = rig.state(task);
        assert_eq!(
            rig.slot(task).await,
            DispatchOutcome::Refused("gate_closed".into()),
            "{}",
            task.as_str()
        );
        let after = rig.state(task);
        assert_eq!(after.last_status, Some(RunStatus::Skipped));
        assert_eq!(after.last_skip_code.as_deref(), Some("inputs_unchanged"));
        assert_eq!(after.last_run_at, before.last_run_at);
        assert!(after.next_due_at > before.next_due_at);
    }
    let script = rig.script.lock().unwrap();
    assert_eq!((script.sends, script.routes), (0, 0));
    assert_eq!(wire.selects.load(Ordering::SeqCst), 0);
    assert_eq!(wire.runner_routes.load(Ordering::SeqCst), 0);
    assert_eq!(wire.sends.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn production_gate_memory_input_matrix() {
    let edits=[
        "INSERT INTO memories(project_path,category,content,normalized_hash,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,'NAMING','New fact.','new',50,'project',0,'active',1,1,1,1)",
        "UPDATE memories SET category='NAMING' WHERE id=1",
        "UPDATE memories SET content='Changed fact.' WHERE id=1",
        "UPDATE memories SET importance=51 WHERE id=1",
        "UPDATE memories SET scope='workspace' WHERE id=1",
        "UPDATE memories SET shareable=1 WHERE id=1",
        "UPDATE memories SET status='archived' WHERE id=1",
    ];
    for &task in OPERATIONAL_TASKS.iter().filter(|&&task| memory_kind(task)) {
        for edit in edits {
            let mut rig = Rig::new();
            rig.seed(task);
            let state = rig.state(task);
            assert_eq!(
                rig.dispatcher
                    .executor
                    .gate(task, &rig.dispatcher.scope, &state, "unchanged")
                    .await
                    .unwrap(),
                GateDecision::Skip {
                    code: "inputs_unchanged".into()
                }
            );
            rig.sql(edit);
            assert_eq!(
                rig.dispatcher
                    .executor
                    .gate(task, &rig.dispatcher.scope, &state, "changed")
                    .await
                    .unwrap(),
                GateDecision::Run,
                "{}: {edit}",
                task.as_str()
            );
        }
    }
}

#[tokio::test]
async fn whitespace_content_is_an_input() {
    for &task in OPERATIONAL_TASKS.iter().filter(|&&task| memory_kind(task)) {
        let mut rig = Rig::new();
        rig.seed(task);
        let state = rig.state(task);
        rig.sql("UPDATE memories SET content='Original   fact.' WHERE id=1");
        assert_eq!(
            rig.dispatcher
                .executor
                .gate(task, &rig.dispatcher.scope, &state, "space")
                .await
                .unwrap(),
            GateDecision::Run,
            "{}",
            task.as_str()
        );
    }
}

#[tokio::test]
async fn verify_file_input() {
    for task in [TaskName::Verify, TaskName::VerifyBroad] {
        let mut rig = Rig::new();
        let path = rig.dispatcher.config.directory.join("mapped.rs");
        std::fs::write(&path, "old").unwrap();
        rig.sql("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at) VALUES(1,'mapped.rs',1,1)");
        rig.seed(task);
        let state = rig.state(task);
        std::fs::write(path, "new").unwrap();
        assert_eq!(
            rig.dispatcher
                .executor
                .gate(task, &rig.dispatcher.scope, &state, "file")
                .await
                .unwrap(),
            GateDecision::Run
        );
    }
}

#[tokio::test]
async fn project_store_key_is_not_used_as_a_folder() {
    let mut rig = Rig::new();
    let path = mapped_repo(&rig);
    rig.sql("UPDATE memories SET project_path='pj-store-key'");
    rig.dispatcher.scope.project = ProjectId("pj-store-key".into());
    let task = TaskName::Verify;
    rig.seed(task);
    let state = rig.state(task);
    std::fs::write(path, "new bytes").unwrap();
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "folder")
            .await
            .unwrap(),
        GateDecision::Run
    );
}

#[tokio::test]
async fn review_candidate_input() {
    let mut rig = Rig::new();
    let task = TaskName::ReviewUserMemories;
    rig.seed(task);
    let state = rig.state(task);
    rig.sql("INSERT INTO user_memory_candidates(content,session_id,created_at) VALUES('Candidate','session',1)");
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "candidate")
            .await
            .unwrap(),
        GateDecision::Run
    );
}

async fn capture_gate_baseline(rig: &mut Rig, task: TaskName) -> ScheduleState {
    rig.seed(task);
    let mut state = rig.state(task);
    state.inputs_watermark = None;
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "first")
            .await
            .unwrap(),
        GateDecision::Run
    );
    state.inputs_watermark = Some(rig.inputs(task).watermark());
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "unchanged")
            .await
            .unwrap(),
        GateDecision::Skip {
            code: "inputs_unchanged".into()
        }
    );
    state
}

fn archived_message(rig: &Rig, id: &str, ordinal: i64, role: &str, ts: i64) {
    rig.dispatcher.store.with_context_conn_for_test(|tx| {
        crate::dream_dispatch::session_reader::install_archive_for_test(tx)?;
        crate::dream_dispatch::session_reader::archive_for_test(tx, "history", &json!({"id":id,"ordinal":ordinal,"role":role,"createdAt":ts,"parts":[{"type":"text","text":"User history for retrospective."}]}))?;
        tx.execute("INSERT INTO schema_migrations_meta(key,value) VALUES('retrospective_activity:history',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [ts.to_string()])?;
        Ok(())
    }).unwrap();
}

#[tokio::test]
async fn retrospective_capture_tracks_archive_ordinals() {
    let mut rig = Rig::new();
    let _ = mapped_repo(&rig);
    rig.sql("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES('history','opencode',?1,1)");
    archived_message(&rig, "user-1", 1, "user", 100);
    rig.sql("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES('second','opencode',?1,1)");
    rig.dispatcher.store.with_context_conn_for_test(|tx| {
        crate::dream_dispatch::session_reader::archive_for_test(tx,"second",&json!({"id":"second-10","ordinal":10,"role":"user","createdAt":100,"parts":[]}))?;
        tx.execute("INSERT INTO schema_migrations_meta(key,value) VALUES('retrospective_activity:second','100')",[])?;
        Ok(())
    }).unwrap();
    let task = TaskName::Retrospective;
    assert_eq!(
        rig.inputs(task).archive_ordinals,
        BTreeMap::from([("history".into(), 1), ("second".into(), 10)])
    );
    let mut state = capture_gate_baseline(&mut rig, task).await;
    state.retrospective_watermark_ms = Some(100);
    archived_message(&rig, "assistant", 2, "assistant", 200);
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "assistant")
            .await
            .unwrap(),
        GateDecision::Run
    );
    state.inputs_watermark = Some(rig.inputs(task).watermark());
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "unchanged-ordinals")
            .await
            .unwrap(),
        GateDecision::Skip {
            code: "inputs_unchanged".into()
        }
    );
    archived_message(&rig, "user-2", 3, "user", 300);
    assert_eq!(
        rig.inputs(task).archive_ordinals,
        BTreeMap::from([("history".into(), 3), ("second".into(), 10)])
    );
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "new-user")
            .await
            .unwrap(),
        GateDecision::Run
    );
}

#[tokio::test]
async fn maintain_docs_capture_tracks_real_git_anchor() {
    let mut rig = Rig::new();
    let path = mapped_repo(&rig);
    let task = TaskName::MaintainDocs;
    assert!(!rig.inputs(task).git.is_empty());
    let state = capture_gate_baseline(&mut rig, task).await;
    std::fs::write(path, "New committed documentation input.").unwrap();
    git(&rig.dispatcher.config.directory, &["add", "mapped.rs"]);
    git(
        &rig.dispatcher.config.directory,
        &["commit", "-qm", "new input"],
    );
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "new-head")
            .await
            .unwrap(),
        GateDecision::Run
    );
}

#[tokio::test]
async fn refresh_primers_capture_tracks_real_snapshot_and_files() {
    let mut rig = Rig::new();
    let path = mapped_repo(&rig);
    rig.sql("INSERT INTO primer_candidates(id,project_path,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_message_time,created_at) VALUES(1,?1,'primer','How is this configured?','how is this configured',1,1,1,1)");
    rig.sql("INSERT INTO compartments(id,session_id,sequence,start_message,end_message,title,content,p1,created_at) VALUES(1,'primer',1,1,1,'Orientation','Primer context','Primer seed summary',1)");
    rig.sql("INSERT INTO primers(id,project_path,question,answer,last_observed_at,answer_refreshed_at,source_candidate_ids,created_at,updated_at) VALUES(1,?1,'How is this configured?','Known answer',1,1,'[1]',1,1)");
    let task = TaskName::RefreshPrimers;
    let inputs = rig.inputs(task);
    assert_eq!(inputs.candidates, BTreeSet::from([1]));
    assert!(!inputs.primers.is_empty());
    assert!(!inputs.unavailable);
    let snapshot = rig
        .dispatcher
        .store
        .load_dream_primers(&rig.dispatcher.scope.project.0)
        .unwrap();
    let active =
        serde_json::from_value::<Vec<crate::dream_tasks::primers::Primer>>(json!(snapshot.primers))
            .unwrap();
    let candidates = serde_json::from_value::<Vec<crate::dream_tasks::primers::Candidate>>(json!(
        snapshot.candidates
    ))
    .unwrap();
    let compartments = serde_json::from_value::<Vec<crate::dream_tasks::primers::SeedCompartment>>(
        json!(snapshot.compartments),
    )
    .unwrap();
    let seed = crate::dream_tasks::primers::build_seed(
        &active[0],
        &candidates,
        None,
        &compartments,
        |text| text.len().div_ceil(4),
    );
    assert!(seed.orientation.contains("Primer seed summary"));
    let mut state = capture_gate_baseline(&mut rig, task).await;
    for sql in [
        "UPDATE primer_candidates SET question='Changed candidate question' WHERE id=1",
        "UPDATE primers SET question='Changed active primer question' WHERE id=1",
        "UPDATE compartments SET p1='Changed primer seed' WHERE id=1",
        "INSERT INTO primer_candidates(id,project_path,session_id,question,normalized_question,source_message_time,created_at) VALUES(2,?1,'primer-2','A new candidate','a new candidate',2,2)",
    ] {
        rig.sql(sql);
        assert_eq!(rig.dispatcher.executor.gate(task,&rig.dispatcher.scope,&state,"primer-change").await.unwrap(),GateDecision::Run);
        state.inputs_watermark = Some(rig.inputs(task).watermark());
        assert_eq!(rig.dispatcher.executor.gate(task,&rig.dispatcher.scope,&state,"primer-unchanged").await.unwrap(),GateDecision::Skip {code:"inputs_unchanged".into()});
    }
    rig.sql("UPDATE primers SET last_observed_at=2 WHERE id=1");
    state.inputs_watermark = Some(rig.inputs(task).watermark());
    assert!(rig.inputs(task).unavailable);
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(task, &rig.dispatcher.scope, &state, "queued-unchanged")
            .await
            .unwrap(),
        GateDecision::Run
    );
    std::fs::write(
        rig.dispatcher.config.directory.join(".git/info/exclude"),
        "ignored.rs\n",
    )
    .unwrap();
    for path in [
        path,
        rig.dispatcher.config.directory.join("untracked.rs"),
        rig.dispatcher.config.directory.join("ignored.rs"),
    ] {
        std::fs::write(&path, "Changed primer investigation input").unwrap();
        assert_eq!(
            rig.dispatcher
                .executor
                .gate(task, &rig.dispatcher.scope, &state, "file-change")
                .await
                .unwrap(),
            GateDecision::Run
        );
        state.inputs_watermark = Some(rig.inputs(task).watermark());
    }
}

#[tokio::test]
async fn missing_git_anchor_remains_due_instead_of_freezing() {
    let mut rig = Rig::new();
    let task = TaskName::MaintainDocs;
    rig.seed(task);
    let state = rig.state(task);
    assert!(rig.inputs(task).unavailable);
    for _ in 0..2 {
        assert_eq!(
            rig.dispatcher
                .executor
                .gate(task, &rig.dispatcher.scope, &state, "unknown-input")
                .await
                .unwrap(),
            GateDecision::Run
        );
    }
}

#[test]
fn declarations_for_kinds_without_a_production_executor() {
    let rig = Rig::new();
    rig.seed(TaskName::Curate);
    let mut state = rig.state(TaskName::Curate);
    let base = Inputs::default();
    state.inputs_watermark = Some(base.watermark());
    let rows = [
        (
            TaskName::CompressCues,
            Inputs {
                memory: "changed".into(),
                ..base.clone()
            },
        ),
        (
            TaskName::Map,
            Inputs {
                attempted: BTreeSet::from([2]),
                ..base.clone()
            },
        ),
        (
            TaskName::Retrospective,
            Inputs {
                archive_ordinals: BTreeMap::from([("session".into(), 2)]),
                ..base.clone()
            },
        ),
        (
            TaskName::RefreshPrimers,
            Inputs {
                candidates: BTreeSet::from([2]),
                ..base.clone()
            },
        ),
        (
            TaskName::RefreshPrimers,
            Inputs {
                primers: "changed snapshot".into(),
                ..base.clone()
            },
        ),
        (
            TaskName::MaintainDocs,
            Inputs {
                git: "new anchor".into(),
                ..base.clone()
            },
        ),
    ];
    for (kind, changed) in rows {
        assert!(!base.due(kind, &state));
        assert!(changed.due(kind, &state), "{}", kind.as_str());
    }
    assert!(base.due(TaskName::PromotePrimers, &state));
    drop(rig);
}

#[tokio::test]
async fn expiry_does_not_make_any_memory_kind_due() {
    let mut rig = Rig::new();
    rig.sql("UPDATE memories SET expires_at=1000 WHERE id=1");
    for &task in OPERATIONAL_TASKS {
        rig.seed(task);
    }
    assert_eq!(
        rig.slot(TaskName::Curate).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
    let status: String = rig
        .dispatcher
        .store
        .with_context_read(|db| {
            db.query_row("SELECT status FROM memories WHERE id=1", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(status, "archived");
    for &task in OPERATIONAL_TASKS {
        assert_eq!(
            rig.slot(task).await,
            DispatchOutcome::Refused("gate_closed".into()),
            "{}",
            task.as_str()
        );
    }
    assert_eq!(rig.script.lock().unwrap().sends, 0);
    rig.sql("UPDATE memories SET metadata_json=NULL WHERE id=1");
    let state = rig.state(TaskName::Curate);
    assert_eq!(
        rig.dispatcher
            .executor
            .gate(TaskName::Curate, &rig.dispatcher.scope, &state, "status")
            .await
            .unwrap(),
        GateDecision::Run
    );
}

#[tokio::test]
async fn failed_and_skipped_runs_keep_claim_watermark() {
    let rig = Rig::new();
    let task = TaskName::Curate;
    rig.seed(task);
    let original = rig.state(task).inputs_watermark;
    rig.sql("UPDATE memories SET content='Changed fact.' WHERE id=1");
    let mut state = rig.state(task);
    let before = state.clone();
    let mut outcome = RunOutcome::new(RunStatus::Skipped);
    outcome.inputs_watermark = Some(rig.inputs(task).watermark());
    // Finish through the store so the same publication rule covers host skips,
    // hard failures and transient retries, not only a closed claim-time gate.
    for (n, status) in [RunStatus::Skipped, RunStatus::Failed, RunStatus::Failed]
        .into_iter()
        .enumerate()
    {
        let now = state.next_due_at.unwrap();
        let request = DreamClaimRequest {
            scope: rig.dispatcher.scope.clone(),
            task: BackgroundTask::Curate,
            domain: task.lease_key(&rig.dispatcher.scope.project.0),
            invocation: InvocationId(format!("failure-{n}")),
            now_ms: now,
            lease_ms: 60_000,
            token_budget: 100,
            manual_force: false,
        };
        let lease = rig
            .dispatcher
            .scheduler
            .claim_task(&request, task, None, |_| true)
            .available();
        outcome.status = status;
        outcome.transient = n == 2;
        rig.dispatcher
            .scheduler
            .finish_task(
                &DreamFinishRequest {
                    lease,
                    now_ms: now + 1,
                    spent_tokens: 0,
                    succeeded: false,
                },
                &outcome,
            )
            .available();
        state = rig.state(task);
        assert_eq!(state.inputs_watermark, original);
        assert_eq!(state.last_run_at, before.last_run_at);
        if n == 2 {
            assert_eq!(state.retry_count, 1);
            assert_eq!(state.next_due_at, Some(now));
        }
    }
}

fn project_pin(domain: Option<&str>) -> MemoryContext {
    let records: Value = serde_json::from_str(include_str!(
        "../../testdata/entorhinal-memory-context-v1/context-project.json"
    ))
    .unwrap();
    let mut reply = records[0]["reply"]["result"].clone();
    reply["domain"] = json!(domain);
    memory_profile::resolve(
        &ContextAnswer::Answer(serde_json::from_value(reply).unwrap()),
        &ContextAnswer::NotAnswering,
        &[],
    )
}

#[tokio::test]
async fn one_context_read_is_the_create_authority_and_holds_no_sqlite_lock() {
    let mut rig = Rig::new();
    let task = TaskName::Curate;
    *rig.source.pin.lock().unwrap() = project_pin(None);
    let expected = rig.source.pin.lock().unwrap().snapshot_digest.clone();
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    rig.dispatcher
        .store
        .set_memory_create_hook(Some(Arc::new(move |_, event| {
            captured.lock().unwrap().push(event.clone());
            Ok(())
        })));
    rig.seed(task);
    rig.sql("UPDATE memories SET content='Changed fact.' WHERE id=1");
    rig.script.lock().unwrap().writes.push(
        json!({"action":"write","category":"ARCHITECTURE","content":"A new architectural fact."}),
    );
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(rig.source.calls.load(Ordering::SeqCst), 1);
    let events = events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].snapshot_digest, expected);
    assert_eq!(
        serde_json::to_value(&events[0].owner).unwrap(),
        json!({"kind":"project","id":"served-project"})
    );
}

#[tokio::test]
async fn not_answering_uses_no_placement_and_does_not_stall_tick() {
    let mut rig = Rig::new();
    let task = TaskName::Curate;
    rig.seed(task);
    rig.sql("UPDATE memories SET content='Changed fact.' WHERE id=1");
    rig.script
        .lock()
        .unwrap()
        .writes
        .push(json!({"action":"write","category":"ARCHITECTURE","content":"Offline fact."}));
    let outcome = tokio::time::timeout(Duration::from_secs(2), rig.slot(task))
        .await
        .expect("unavailable context must not stall the project tick");
    assert_eq!(outcome, DispatchOutcome::Finished(RunStatus::Completed));
    let count: i64 = rig
        .dispatcher
        .store
        .with_context_read(|db| {
            db.query_row("SELECT COUNT(*) FROM memory_placement", [], |row| {
                row.get(0)
            })
        })
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(rig.source.calls.load(Ordering::SeqCst), 1);
    // The real reader has the same no-provider fast path and 500 ms bound.
    let reader = MemoryContextReader::new(
        None,
        subc_protocol::BindIdentity::new(
            rig.dispatcher.config.directory.clone(),
            "magic-context",
            "dream",
        ),
    );
    let answer = tokio::time::timeout(
        Duration::from_secs(1),
        memory_profile::project_profile(&reader, &rig.dispatcher.scope.project.0, &[]),
    )
    .await
    .unwrap();
    assert_eq!(answer.profile.state, "entorhinal_not_answering");
}

#[tokio::test]
async fn unresolved_slots_skip_but_manual_curate_keeps_null_origin() {
    let mut rig = Rig::new();
    *rig.source.pin.lock().unwrap() = project_pin(Some("@acme/domain-legal"));
    for &task in OPERATIONAL_TASKS.iter().filter(|&&task| memory_kind(task)) {
        rig.seed(task);
        assert_eq!(
            rig.slot(task).await,
            DispatchOutcome::Refused("gate_closed".into())
        );
        assert_eq!(
            rig.state(task).last_skip_code.as_deref(),
            Some("unresolved")
        );
    }
    assert_eq!(rig.script.lock().unwrap().sends, 0);
    rig.script.lock().unwrap().writes.push(
        json!({"action":"write","category":"ARCHITECTURE","content":"Manual degraded fact."}),
    );
    let before = rig.source.calls.load(Ordering::SeqCst);
    assert_eq!(
        rig.dispatcher
            .manual(
                &Rig::config(TaskName::Curate),
                "manual",
                Duration::from_secs(30 * 60),
                Cancellation::default()
            )
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(rig.source.calls.load(Ordering::SeqCst), before + 1);
    rig.dispatcher
        .store
        .with_context_read(|db| {
            let (owner, origin, category): (String, Option<String>, Option<String>) = db
                .query_row(
                    "SELECT owner_id,origin_profile_name,origin_category FROM memory_placement",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            assert_eq!(owner, "served-project");
            assert_eq!(origin, None);
            assert_eq!(category, None);
            assert_eq!(
                db.query_row("SELECT COUNT(*) FROM memory_ops", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn manual_degraded_memory_kinds_bypass_the_gate() {
    for task in [
        TaskName::Classify,
        TaskName::Map,
        TaskName::Verify,
        TaskName::VerifyBroad,
    ] {
        let mut rig = Rig::new();
        *rig.source.pin.lock().unwrap() = project_pin(Some("@acme/domain-legal"));
        let _ = mapped_repo(&rig);
        if task == TaskName::Map {
            rig.sql("DELETE FROM memory_verifications");
        }
        rig.script.lock().unwrap().text = match task {
            TaskName::Map => "<mappings><memory id=\"1\" independent=\"true\"/></mappings>",
            TaskName::Verify | TaskName::VerifyBroad => {
                "<verify><verified id=\"1\" files=\"mapped.rs\"/></verify>"
            }
            _ => "<classify></classify>",
        }
        .into();
        rig.seed(task);
        assert_eq!(
            rig.slot(task).await,
            DispatchOutcome::Refused("gate_closed".into())
        );
        assert_eq!(rig.script.lock().unwrap().sends, 0);
        let calls = rig.source.calls.load(Ordering::SeqCst);
        assert_eq!(
            rig.dispatcher
                .manual(
                    &Rig::config(task),
                    "manual-degraded",
                    Duration::from_secs(30 * 60),
                    Cancellation::default()
                )
                .await,
            DispatchOutcome::Finished(RunStatus::Completed),
            "{}",
            task.as_str()
        );
        assert_eq!(rig.source.calls.load(Ordering::SeqCst), calls + 1);
    }
}

fn git(root: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.test"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn mapped_repo(rig: &Rig) -> std::path::PathBuf {
    let root = &rig.dispatcher.config.directory;
    let path = root.join("mapped.rs");
    std::fs::write(&path, "old").unwrap();
    git(root, &["init", "-q"]);
    git(root, &["add", "mapped.rs"]);
    git(root, &["commit", "-qm", "initial"]);
    rig.sql("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at) VALUES(1,'mapped.rs',0,1)");
    path
}

#[tokio::test]
async fn inflight_verify_file_change_survives_completion() {
    let mut rig = Rig::new();
    let task = TaskName::Verify;
    let path = mapped_repo(&rig);
    rig.seed(task);
    rig.sql("UPDATE memories SET importance=51 WHERE id=1");
    {
        let mut script = rig.script.lock().unwrap();
        script.text = "<verify><verified id=\"1\" files=\"mapped.rs\"/></verify>".into();
        script.edit = Some((path, "changed during model work".into()));
    }
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    let state = rig.state(task);
    assert!(
        rig.inputs(task).due(task, &state),
        "the file edited after claim must be due next slot"
    );
    let sends = rig.script.lock().unwrap().sends;
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert!(rig.script.lock().unwrap().sends > sends);
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
}

#[tokio::test]
async fn unmappable_memory_is_not_retried_every_map_slot() {
    let mut rig = Rig::new();
    let task = TaskName::Map;
    let _ = mapped_repo(&rig);
    rig.sql("DELETE FROM memory_verifications");
    rig.seed(task);
    let mut state = rig.state(task);
    state.inputs_watermark = None;
    rig.save(task, &state);
    rig.script.lock().unwrap().text =
        "<mappings><memory id=\"1\" independent=\"true\"/></mappings>".into();
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
    // A fake completed mapper can leave neither an empty-path verification
    // record nor a file mapping. Its claim-time attempted ids still prevent
    // retrying that same row forever.
    rig.sql("DELETE FROM memory_verifications");
    let captured = rig.inputs(task).watermark();
    let mut state = rig.state(task);
    state.inputs_watermark = None;
    rig.save(task, &state);
    let now = state.next_due_at.unwrap();
    let request = DreamClaimRequest {
        scope: rig.dispatcher.scope.clone(),
        task: BackgroundTask::Map,
        domain: task.lease_key(&rig.dispatcher.scope.project.0),
        invocation: InvocationId("fake-unmappable".into()),
        now_ms: now,
        lease_ms: 60_000,
        token_budget: 100,
        manual_force: false,
    };
    let lease = rig
        .dispatcher
        .scheduler
        .claim_task(&request, task, None, |_| true)
        .available();
    let mut done = RunOutcome::new(RunStatus::Completed);
    done.inputs_watermark = Some(captured);
    rig.dispatcher
        .scheduler
        .finish_task(
            &DreamFinishRequest {
                lease,
                now_ms: now + 1,
                spent_tokens: 0,
                succeeded: true,
            },
            &done,
        )
        .available();
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
}

#[tokio::test]
async fn truncated_map_keeps_unstarted_batch_due() {
    let mut rig = Rig::new();
    let task = TaskName::Map;
    let _ = mapped_repo(&rig);
    rig.sql("DELETE FROM memory_verifications");
    rig.dispatcher.store.with_context_conn_for_test(|db| {
        for id in 2..=21 {
            let content = format!("Unmapped fact {id}.");
            db.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,importance,scope,shareable,status,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,'ARCHITECTURE',?3,?4,50,'project',0,'active',1,1,1,1)",rusqlite::params![id,rig.dispatcher.scope.project.0,content,mc_store::compute_normalized_memory_hash(&content)])?;
        }
        Ok(())
    }).unwrap();
    rig.seed(task);
    let mut state = rig.state(task);
    state.inputs_watermark = None;
    rig.save(task, &state);
    let now = state.next_due_at.unwrap();
    rig.clock.0.store(now, Ordering::SeqCst);
    {
        let mut script = rig.script.lock().unwrap();
        script.text = format!(
            "<mappings>{}</mappings>",
            (1..=20)
                .map(|id| format!("<memory id=\"{id}\" independent=\"true\"/>"))
                .collect::<String>()
        );
        script.clock_jump = Some((rig.clock.clone(), now + 90_000));
    }
    let report = rig
        .dispatcher
        .tick(&[Rig::config(task)], true, Duration::from_secs(5 * 60))
        .await
        .unwrap();
    assert_eq!(report[0].1, DispatchOutcome::Finished(RunStatus::Completed));
    let state = rig.state(task);
    let watermark: Inputs =
        serde_json::from_value(state.inputs_watermark.clone().unwrap()).unwrap();
    assert_eq!(watermark.attempted, (1..=20).collect());
    assert!(!watermark.attempted.contains(&21));
    assert!(rig.inputs(task).due(task, &state));
    rig.script.lock().unwrap().text =
        "<mappings><memory id=\"21\" independent=\"true\"/></mappings>".into();
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
}

#[tokio::test]
async fn curate_self_write_runs_once_more_then_skips_and_preserves_parent_bytes() {
    let mut rig = Rig::new();
    let task = TaskName::Curate;
    rig.seed(task);
    rig.sql("INSERT INTO session_meta(session_id,served_prefix) VALUES('parent','frozen prefix')");
    rig.sql("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES('parent','cached_m0_bytes',X'6d30')");
    rig.sql("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES('parent','cached_m1_bytes',X'6d31')");
    let meta = rig.dispatcher.store.load_meta("parent").unwrap();
    rig.dispatcher
        .store
        .commit_meta("parent", meta.row_version, &meta.meta)
        .unwrap();
    let parent = || {
        let bytes=rig.dispatcher.store.with_context_read(|db| db.prepare("SELECT cache_key,value FROM session_render_cache WHERE session_id='parent' ORDER BY cache_key")?.query_map([],|row| Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()).unwrap();
        (
            bytes,
            rig.dispatcher
                .store
                .load_meta("parent")
                .unwrap()
                .row_version,
        )
    };
    let before = parent();
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
    let after_skip = rig
        .dispatcher
        .store
        .load_meta("parent")
        .unwrap()
        .row_version;
    assert_eq!(after_skip, before.1);
    rig.sql("UPDATE memories SET content='Changed fact.' WHERE id=1");
    rig.script
        .lock()
        .unwrap()
        .writes
        .push(json!({"action":"update","ids":[1],"content":"Curated fact."}));
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    let bytes=rig.dispatcher.store.with_context_read(|db| db.prepare("SELECT cache_key,value FROM session_render_cache WHERE session_id='parent' ORDER BY cache_key")?.query_map([],|row| Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()).unwrap();
    assert_eq!(bytes, before.0);
    assert_eq!(
        rig.dispatcher
            .store
            .load_meta("parent")
            .unwrap()
            .row_version,
        before.1
    );
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(
        rig.slot(task).await,
        DispatchOutcome::Refused("gate_closed".into())
    );
    let sends = rig.script.lock().unwrap().sends;
    assert_eq!(
        rig.dispatcher
            .manual(
                &Rig::config(task),
                "force",
                Duration::from_secs(30 * 60),
                Cancellation::default()
            )
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert!(rig.script.lock().unwrap().sends > sends);
}

#[tokio::test]
async fn gated_curate_has_the_same_pressure_and_mutation_effects_as_forced() {
    let mut gated = Rig::new();
    let mut forced = Rig::new();
    let task = TaskName::Curate;
    for rig in [&gated, &forced] {
        rig.seed(task);
        rig.sql("INSERT INTO project_state(project_path,project_memory_epoch) VALUES(?1,7)");
        rig.sql("UPDATE memories SET content='Changed fact.' WHERE id=1");
        rig.script
            .lock()
            .unwrap()
            .writes
            .push(json!({"action":"update","ids":[1],"content":"Curated fact."}));
    }
    let now = gated.state(task).next_due_at.unwrap();
    forced.clock.0.store(now, Ordering::SeqCst);
    assert_eq!(
        gated.slot(task).await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    assert_eq!(
        forced
            .dispatcher
            .manual(
                &Rig::config(task),
                "forced-writer",
                Duration::from_secs(30 * 60),
                Cancellation::default()
            )
            .await,
        DispatchOutcome::Finished(RunStatus::Completed)
    );
    let effects = |rig: &Rig| {
        rig.dispatcher.store.with_context_read(|db| {
        let pressure:(i64,i64)=db.query_row("SELECT project_memory_epoch,project_user_profile_version FROM project_state WHERE project_path=?1",[&rig.dispatcher.scope.project.0],|row| Ok((row.get(0)?,row.get(1)?)))?;
        let mutations=db.prepare("SELECT mutation_type,target_memory_id,new_content FROM memory_mutation_log WHERE project_path=?1 ORDER BY id")?.query_map([&rig.dispatcher.scope.project.0],|row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<i64>>(1)?,row.get::<_,Option<String>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((pressure,mutations))
    }).unwrap()
    };
    let gated_effects = effects(&gated);
    assert_eq!(gated_effects, effects(&forced));
    assert_eq!(gated_effects.0, (7, 0));
    assert_eq!(gated_effects.1.len(), 0);
}
