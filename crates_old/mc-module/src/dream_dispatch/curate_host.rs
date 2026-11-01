//! Category curation through the existing transactional memory actions.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use mc_store::{dream_curate::CurateEdit, dream_scheduler::schedules::TaskName, McStore};
use rusqlite::{OptionalExtension, Transaction};
use serde_json::{json, Value};

use super::{
    adapters::EmbeddingQueue,
    context::{ControlError, TaskContext, TaskToolRouter, ToolError, ToolReceipt, ToolResult},
};
use crate::{
    dream_runner::{Attempt, CarrierError, ChildRequest, Completion, DreamCarrier, Failure},
    dream_tasks::curate::{self, CurateCarrier, PromptMemory, Success},
    memory_actions::{MemoryActionArgs, MemoryActionContext, MemoryActions, MemoryRole},
};

#[derive(Debug)]
pub enum CurateError {
    WrongTask,
    Control(ControlError),
    Store(String),
    Run(Failure),
}

pub struct CurateHost<C: CurateCarrier> {
    carrier: RoutedCarrier<C>,
    router: Arc<CurateRouter>,
    attempts: Vec<Attempt>,
}

impl<C: CurateCarrier> CurateHost<C> {
    /// Construct the carrier with the same fenced router the host prepares before
    /// opening a child. The carrier must route admitted ctx_memory calls here.
    pub fn new(
        store: Arc<McStore>,
        context: Arc<TaskContext>,
        carrier: impl FnOnce(Arc<dyn TaskToolRouter>) -> C,
    ) -> Self {
        let run = json!([
            context.scope.project.0,
            context.scope.session.0,
            context.scope.generation.0,
            context.task_lease.invocation.0
        ])
        .to_string();
        let router = Arc::new(CurateRouter {
            store,
            context,
            run,
            state: Mutex::new(RouterState::default()),
        });
        Self {
            carrier: RoutedCarrier {
                inner: carrier(router.clone()),
                router: router.clone(),
            },
            router,
            attempts: Vec::new(),
        }
    }

    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    /// Run the canonical curate planner/runner, not a second prompt implementation.
    /// Expiry is a separate task; expired memories are excluded from this snapshot.
    pub async fn run(&mut self) -> Result<Success, CurateError> {
        self.attempts.clear();
        let router = self.router.clone();
        let ctx = &router.context;
        if ctx.task != TaskName::Curate {
            return Err(CurateError::WrongTask);
        }
        if !ctx.config.activated {
            return Err(CurateError::Run(Failure::Inactive));
        }
        ctx.check_control().map_err(CurateError::Control)?;
        let snapshot = router
            .store
            .load_dream_curate(&ctx.scope.project.0, &router.run, ctx.now_ms())
            .map_err(|e| CurateError::Store(e.to_string()))?;
        if let Some(done) = snapshot.completed {
            return Ok(Success {
                completed_actions: serde_json::from_value(done["completedActions"].clone())
                    .map_err(|e| CurateError::Store(e.to_string()))?,
                detail: done["detail"]
                    .as_str()
                    .ok_or_else(|| CurateError::Store("invalid curate replay result".into()))?
                    .into(),
                task_state: done.get("taskState").filter(|v| !v.is_null()).cloned(),
            });
        }
        let mut revisions = HashMap::new();
        let memories = snapshot
            .memories
            .into_iter()
            .filter_map(|row| {
                let m = row.memory;
                curate::category_bucket(&m.category)?;
                revisions.insert(m.id, row.revision);
                Some(PromptMemory {
                    id: m.id,
                    category: m.category,
                    content: m.content,
                    mapped_files: row
                        .files
                        .iter()
                        .filter(|f| !f.is_empty())
                        .cloned()
                        .collect(),
                    has_no_file_sentinel: row.files.iter().any(String::is_empty),
                    importance: m.importance.unwrap_or(50) as f64,
                    retrieval_count: m.retrieval_count as f64,
                    seen_count: m.seen_count as f64,
                })
            })
            .collect::<Vec<_>>();
        let max_characters = ctx
            .config
            .route
            .historian_context_limit_tokens
            .saturating_mul(2)
            .max(4000);
        let plan = curate::prepare(snapshot.state.as_deref(), &memories, max_characters);
        if let Some(plan) = &plan {
            router
                .store
                .save_dream_curate_progress(
                    &ctx.scope.project.0,
                    &router.run,
                    &plan.begin_state,
                    None,
                    |tx| router.check_commit_fence(tx),
                )
                .map_err(|e| CurateError::Store(e.to_string()))?;
            *router.state.lock().unwrap_or_else(|e| e.into_inner()) = RouterState {
                category: Some(plan.category),
                revisions,
                ..RouterState::default()
            };
        }
        let result = curate::run(
            true,
            &ctx.config.route,
            &ctx.config.effective,
            &curate::RunContext {
                harness: &ctx.config.harness,
                project_path: &ctx.scope.project.0,
                parent_session_id: &ctx.scope.session.0,
                directory: ctx.directory(),
                timeout: Duration::from_millis(
                    ctx.deadline_ms.saturating_sub(ctx.now_ms()).max(0) as u64
                ),
                token_budget: ctx.task.default_budget(),
                language: ctx.config.effective["language"].as_str(),
                expired_archived: 0,
            },
            plan.as_ref(),
            &mut self.carrier,
        )
        .await;
        self.attempts = result.attempts;
        if let Some(error) = router
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .failed
            .clone()
        {
            return Err(CurateError::Store(error));
        }
        let success = result.result.map_err(CurateError::Run)?;
        let done = json!({"completedActions": success.completed_actions, "detail": success.detail, "taskState": success.task_state});
        let state = success.task_state.as_ref().cloned().unwrap_or_else(|| {
            snapshot
                .state
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .unwrap_or_else(|| json!({}))
        });
        router
            .store
            .save_dream_curate_progress(
                &ctx.scope.project.0,
                &router.run,
                &state,
                Some(&done),
                |tx| router.check_commit_fence(tx),
            )
            .map_err(|e| CurateError::Store(e.to_string()))?;
        Ok(success)
    }
}

#[derive(Default)]
struct RouterState {
    category: Option<&'static str>,
    revisions: HashMap<i64, i64>,
    actions: MemoryActions,
    failed: Option<String>,
    children: HashSet<String>,
    refusals: HashMap<String, usize>,
}

struct RoutedCarrier<C> {
    inner: C,
    router: Arc<CurateRouter>,
}

impl<C: CurateCarrier> DreamCarrier for RoutedCarrier<C> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        let child = self.inner.open(request).await?;
        self.router
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .children
            .insert(child.clone());
        Ok(child)
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        self.inner.complete(child, request).await
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        self.router
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .children
            .remove(child);
        self.inner.close(child, settled).await
    }
}

impl<C: CurateCarrier> CurateCarrier for RoutedCarrier<C> {
    fn messages(&self, child: &str) -> Value {
        self.inner.messages(child)
    }
    fn safety_refusals(&self, child: &str) -> usize {
        self.router
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .refusals
            .get(child)
            .copied()
            .unwrap_or(0)
    }
}

struct CurateRouter {
    store: Arc<McStore>,
    context: Arc<TaskContext>,
    run: String,
    state: Mutex<RouterState>,
}

impl CurateRouter {
    fn check_commit_fence(&self, tx: &Transaction<'_>) -> rusqlite::Result<()> {
        self.context
            .check_control()
            .map_err(|_| rusqlite::Error::InvalidQuery)?;
        if self.context.task_lease.scope != self.context.scope
            || self.context.domain_lease.key
                != self.context.task.lease_key(&self.context.scope.project.0)
            || self.context.now_ms() >= self.context.task_lease.expires_at_ms
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        mc_store::dream_domain::require_tx(tx, &self.context.domain_lease, self.context.now_ms())
    }
}

impl TaskToolRouter for CurateRouter {
    fn execute(&self, child: &str, tool: &str, arguments: &Value) -> Result<ToolResult, ToolError> {
        if tool != "ctx_memory" {
            return Err(ToolError::NotAdmitted(tool.into()));
        }
        self.context.check_control().map_err(ToolError::Control)?;
        let args: MemoryActionArgs = serde_json::from_value(arguments.clone())
            .map_err(|e| ToolError::InvalidArguments(e.to_string()))?;
        if !matches!(
            args.action.as_deref(),
            Some("write" | "update" | "merge" | "archive")
        ) {
            return Err(ToolError::NotAdmitted(
                "curate only admits memory mutations".into(),
            ));
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if !state.children.contains(child) {
            return Err(ToolError::NotAdmitted("curate child is not open".into()));
        }
        let category = state
            .category
            .ok_or_else(|| ToolError::NotAdmitted("no active curate category".into()))?;
        if let Some(error) = &state.failed {
            return Err(ToolError::Store(error.clone()));
        }
        let ids = args.ids.as_deref().unwrap_or_default();
        let mut expected = Vec::new();
        for id in ids.iter().copied().chain(args.superseded_by) {
            let revision = state.revisions.get(&id).copied().unwrap_or(-1);
            expected.push((id, revision));
        }
        // A restarted child may repeat an edit that already committed. Without a
        // transport call ID, identical requests within one scheduler invocation
        // share a receipt. The memory action checks the complete saved request.
        let request =
            serde_json::to_string(&args).map_err(|e| ToolError::InvalidArguments(e.to_string()))?;
        let key = format!("curate:{}:{}", self.run, mc_store::md5_hex(&request));
        let ctx = &self.context;
        // Every edit commits with its memory_history row and revision bump, the same
        // rows the TypeScript dreamer writes (see
        // curate_update_merge_archive_history_matches_the_typescript_dreamer).
        let applied = self.store.commit_dream_curate(&ctx.scope.project.0, &key, &expected, |tx| self.check_commit_fence(tx), |tx| {
            let replay: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_decision_receipts WHERE decision_key=?1)", [&key], |r| r.get(0))?;
            let reply = state.actions.execute_tx(tx, &EmbeddingQueue, &MemoryActionContext {
                project_path: &ctx.scope.project.0, session_id: &ctx.scope.session.0, harness: &ctx.config.harness,
                role: MemoryRole::Dreamer, workspace_members: &[], shared_categories: &[], curate_category: Some(category),
                memory_enabled: ctx.config.route.memory_enabled, now_ms: ctx.now_ms(), decision_key: &key,
            }, &args)?;
            // Advance revision heads only for this call's new effects, not replay.
            // Other memories retain the revisions shown to the model, so a later
            // call cannot silently accept another writer's intervening changes.
            let heads = if replay { Vec::new() } else { tx.prepare("SELECT id,revision FROM memories WHERE project_path=?1 AND (id IN (SELECT value FROM json_each(?2)) OR id=(SELECT json_extract(receipt_json,'$.memoryId') FROM memory_decision_receipts WHERE decision_key=?3))")?
                .query_map(rusqlite::params![ctx.scope.project.0, json!(ids).to_string(), key], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()? };
            let canonical: Option<i64> = tx.query_row("SELECT json_extract(receipt_json,'$.memoryId') FROM memory_decision_receipts WHERE decision_key=?1", [&key], |r| r.get(0)).optional()?.flatten();
            Ok((reply, heads, canonical))
        });
        let (reply, receipt) = match applied {
            Err(error) => {
                let error = error.to_string();
                state.failed = Some(error.clone());
                return Err(ToolError::Store(error));
            }
            Ok(CurateEdit::Stale(ids)) => (
                format!("Error: stale_revision for memory {ids:?}; edit refused."),
                None,
            ),
            Ok(CurateEdit::Applied((reply, heads, canonical))) => {
                let mut affected = ids.to_vec();
                if let Some(id) = canonical.filter(|id| !affected.contains(id)) {
                    affected.push(id);
                }
                let affected_ids = affected.iter().map(i64::to_string).collect();
                state.revisions.extend(heads);
                let success = reply.starts_with("Updated memory")
                    || reply.starts_with("Merged memories")
                    || reply.starts_with("Archived memor")
                    || reply.starts_with("Saved memory");
                if reply.starts_with("Skipped ") && reply.contains(": curate safety refusal (") {
                    *state.refusals.entry(child.into()).or_default() += ids.len();
                }
                let receipt = success.then(|| ToolReceipt {
                    tool: tool.into(),
                    affected_ids,
                    details: json!({"decisionKey": key, "action": args.action}),
                });
                (reply, receipt)
            }
        };
        Ok(ToolResult {
            output: json!(reply),
            receipt,
        })
    }
}

#[cfg(test)]
mod tests {
    mod undo;
    use super::*;
    use crate::dream_dispatch::context::{
        Cancellation, CapturedConfig, ChildEvent, Clock, TaskControl,
    };
    use mc_store::{
        dream_scheduler::budget::BudgetAction,
        parity_schema_manifest::{
            DreamLease, Generation, InvocationId, ProjectId, SessionId, StoreScope,
        },
        SqliteContextDomain,
    };
    use rusqlite::{params, Connection};
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicBool, AtomicI64, Ordering},
    };

    struct Time(AtomicI64);
    impl Clock for Time {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }
    #[derive(Default)]
    struct Control(AtomicBool);
    impl TaskControl for Control {
        fn check_control(&self) -> Result<(), ControlError> {
            if self.0.load(Ordering::SeqCst) {
                Err(ControlError::LeaseLost)
            } else {
                Ok(())
            }
        }
        fn charge_usage(
            &self,
            _: &str,
            _: &crate::dream_runner::Usage,
            _: bool,
            _: bool,
        ) -> Result<BudgetAction, ControlError> {
            Ok(BudgetAction::Continue)
        }
        fn refuse_tool(&self) -> Result<Option<(&'static str, bool)>, ControlError> {
            Ok(None)
        }
    }
    type Events = Arc<Mutex<Vec<ChildEvent>>>;
    struct FakeCarrier {
        router: Arc<dyn TaskToolRouter>,
        operations: Vec<Value>,
        during_model: Option<Box<dyn FnOnce() + Send>>,
        requests: Arc<Mutex<Vec<ChildRequest>>>,
        events: Events,
        messages: Value,
    }
    impl DreamCarrier for FakeCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.requests.lock().unwrap().push(request.clone());
            Ok(format!("child-{}", self.requests.lock().unwrap().len()))
        }
        async fn complete(
            &mut self,
            child: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            if let Some(callback) = self.during_model.take() {
                callback();
            }
            assert!(
                !self.operations.is_empty(),
                "durable completion must suppress another model call"
            );
            let mut parts = Vec::new();
            for args in &self.operations {
                let result = self
                    .router
                    .execute(child, "ctx_memory", args)
                    .map_err(|e| CarrierError {
                        message: format!("{e:?}"),
                        retryable: false,
                    })?;
                if let Some(receipt) = result.receipt {
                    self.events
                        .lock()
                        .unwrap()
                        .push(ChildEvent::Receipt(receipt));
                }
                parts.push(json!({"type":"tool", "tool":"ctx_memory", "state":{"status":"completed", "input":args, "output":result.output}}));
            }
            self.messages = json!([{"info":{"role":"assistant"},"parts":parts}]);
            let text = "Consolidated the redundant architecture entries.";
            self.events.lock().unwrap().push(ChildEvent::Message {
                message_id: child.into(),
                role: "assistant".into(),
                text: text.into(),
            });
            Ok(Completion {
                text: text.into(),
                ..Completion::default()
            })
        }
        async fn close(&mut self, _: &str, settled: bool) -> Result<(), CarrierError> {
            self.events
                .lock()
                .unwrap()
                .push(ChildEvent::Closed { settled });
            Ok(())
        }
    }
    impl CurateCarrier for FakeCarrier {
        fn messages(&self, _: &str) -> Value {
            self.messages.clone()
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        path: PathBuf,
        store: Arc<McStore>,
        context: Arc<TaskContext>,
        time: Arc<Time>,
        control: Arc<Control>,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join("magic-context/i5-5c");
            std::fs::create_dir_all(&root).unwrap();
            let dir = tempfile::Builder::new()
                .prefix("dream_curate-")
                .tempdir_in(root)
                .unwrap();
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let cortexkit_store_types::StorageBackend::Sqlite { path } = &descriptor.backend else {
                panic!("sqlite fixture");
            };
            let path = PathBuf::from(path).with_file_name("context.db");
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let scope = StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            };
            let domain_lease = store
                .acquire_dream_domain(&TaskName::Curate.lease_key("project"), "holder", 1000)
                .unwrap()
                .unwrap();
            let time = Arc::new(Time(AtomicI64::new(1000)));
            let control = Arc::new(Control::default());
            let context = Arc::new(TaskContext {
                task: TaskName::Curate,
                scope: scope.clone(),
                config: Arc::new(CapturedConfig {
                    activated: true,
                    route: crate::McModuleConfig::default(),
                    effective: json!({}),
                    harness: "opencode".into(),
                    directory: dir.path().to_owned(),
                }),
                domain_lease,
                task_lease: DreamLease {
                    scope,
                    invocation: InvocationId("invocation".into()),
                    token: "token".into(),
                    expires_at_ms: 2_000_000,
                },
                cancellation: Cancellation::default(),
                clock: time.clone(),
                deadline_ms: 2_000_000,
                control: control.clone(),
            });
            store.with_context_conn_for_test(|db| {
                for id in 1..=7 {
                    let project = if id == 7 { "foreign" } else { "project" };
                    let content = format!("Architecture entry {id} describes the project's durable component boundary.");
                    db.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at,metadata_json) VALUES(?1,?2,'ARCHITECTURE',?3,?4,'source',1,1,1,1,'{}')", params![id,project,content,mc_store::compute_normalized_memory_hash(&content)])?;
                    db.execute("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?1,?2,'model')", params![id,vec![0_u8;8]])?;
                }
                db.execute("INSERT INTO session_meta(session_id,served_prefix) VALUES ('session','frozen prefix')", [])?;
                db.execute("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES ('session','cached_m0_bytes',?1)", [b"frozen bytes"])?;
                db.execute("INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project',9)", [])?;
                Ok(())
            }).unwrap();
            Self {
                dir,
                path,
                store,
                context,
                time,
                control,
            }
        }
        fn operations() -> Vec<Value> {
            vec![
                json!({"action":"update","ids":[1],"content":"Architecture entry one describes the enduring component boundary more clearly."}),
                json!({"action":"merge","ids":[2,3],"content":"The component boundary separates transport from durable storage.","category":"ARCHITECTURE"}),
                json!({"action":"archive","ids":[4,5],"superseded_by":6,"reason":"Redundant boundary details survive in the active entry."}),
            ]
        }
        fn host(
            &self,
            operations: Vec<Value>,
            during_model: Option<Box<dyn FnOnce() + Send>>,
        ) -> (CurateHost<FakeCarrier>, Events) {
            let events = Events::default();
            let captured = events.clone();
            (
                CurateHost::new(self.store.clone(), self.context.clone(), |router| {
                    FakeCarrier {
                        router,
                        operations,
                        during_model,
                        requests: Default::default(),
                        events: captured,
                        messages: Value::Null,
                    }
                }),
                events,
            )
        }
        fn scalar(&self, sql: &str) -> i64 {
            self.store
                .with_context_read(|db| db.query_row(sql, [], |r| r.get(0)))
                .unwrap()
        }
        fn state(&self) -> Value {
            self.store
                .with_context_read(|db| {
                    db.query_row(
                        "SELECT last_checked_commit FROM task_schedule_state WHERE task='curate'",
                        [],
                        |r| r.get::<_, String>(0),
                    )
                })
                .map(|raw| serde_json::from_str(&raw).unwrap())
                .unwrap()
        }
        fn assert_no_effects(&self) {
            for table in [
                "memory_history",
                "memory_journal",
                "memory_decision_receipts",
                "memory_mutation_log",
                "memory_agent_fragments",
                "memory_successor_links",
            ] {
                assert_eq!(
                    self.scalar(&format!("SELECT COUNT(*) FROM {table}")),
                    0,
                    "{table}"
                );
            }
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memories WHERE status='archived' OR revision!=1 OR superseded_by_memory_id IS NOT NULL"), 0);
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_embeddings"), 7);
            assert_eq!(
                self.scalar("SELECT COUNT(*) FROM dream_state WHERE key LIKE 'rust:curate:done:%'"),
                0
            );
        }
    }

    #[tokio::test]
    async fn dream_curate_update_merge_archive_have_complete_undo_and_receipts() {
        let f = Fixture::new();
        let (mut host, events) = f.host(Fixture::operations(), None);
        let result = host.run().await.unwrap();
        assert_eq!(result.completed_actions, ["update", "merge", "archive"]);
        assert_eq!(host.attempts().len(), 1);
        let requests = host.carrier.inner.requests.lock().unwrap();
        assert_eq!(requests[0].parent_session_id, "session");
        assert_eq!(requests[0].directory, f.context.config.directory);
        assert_eq!(requests[0].allowed_tools, ["ctx_memory"]);
        assert!(requests[0].prompt.contains("Architecture entry 1"));
        assert!(!requests[0].prompt.contains("Architecture entry 7"));
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history WHERE before_json IS NOT NULL AND after_json IS NOT NULL"), 6);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history WHERE json_extract(before_json,'$.snapshot.revision')=1 AND json_extract(after_json,'$.snapshot.revision')=2 AND json_extract(before_json,'$.snapshot.content')=previous_text AND json_extract(after_json,'$.snapshot.content')=after_text"), 5);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal"), 3);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal WHERE operation='curate_merge' AND json_array_length(before_json,'$.rows')=3 AND json_type(before_json,'$.rows[2].before')='null' AND json_array_length(after_json,'$.rows')=3"), 1);
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM memories WHERE status='archived'"),
            4
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_successor_links"), 4);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_mutation_log"), 0);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_agent_fragments"), 0);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_embeddings"), 2);
        assert_eq!(
            f.scalar("SELECT project_memory_epoch FROM project_state WHERE project_path='project'"),
            9
        );
        f.store.with_context_read(|db| {
            let (prefix, bytes): (String, Vec<u8>) = db.query_row("SELECT served_prefix,(SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes') FROM session_meta WHERE session_id='session'", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
            assert_eq!(prefix, "frozen prefix"); assert_eq!(bytes, b"frozen bytes"); Ok(())
        }).unwrap();
        assert_eq!(f.state(), json!({"curate":{"cursor":2}}));
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ChildEvent::Receipt(_)))
                .count(),
            3
        );
        assert_eq!(
            events
                .iter()
                .filter_map(|event| match event {
                    ChildEvent::Receipt(receipt) => Some(receipt.affected_ids.len()),
                    _ => None,
                })
                .collect::<Vec<_>>(),
            [1, 3, 2]
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ChildEvent::Message { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChildEvent::Closed { settled: true })));
    }

    #[tokio::test]
    async fn dream_curate_stale_revision_refuses_only_that_edit() {
        let f = Fixture::new();
        let store = f.store.clone();
        let (mut host, _) = f.host(Fixture::operations(), Some(Box::new(move || {
            store.with_context_conn_for_test(|db| db.execute_batch("UPDATE memories SET revision=revision+1,content='External current content' WHERE id=1")).unwrap();
        })));
        let result = host.run().await.unwrap();
        assert_eq!(result.completed_actions, ["merge", "archive"]);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memories WHERE id=1 AND content='External current content' AND revision=2"), 1);
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM memory_history WHERE memory_id=1"),
            0
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history"), 5);
    }

    #[tokio::test]
    async fn dream_curate_stolen_domain_at_commit_has_zero_effects() {
        let f = Fixture::new();
        let store = f.store.clone();
        let key = format!("lease:{}:holder", f.context.domain_lease.key);
        let (mut host, _) = f.host(
            Fixture::operations(),
            Some(Box::new(move || {
                store
                    .with_context_conn_for_test(|db| {
                        db.execute(
                            "UPDATE dream_state SET value='successor' WHERE key=?1",
                            [key],
                        )
                        .map(|_| ())
                    })
                    .unwrap();
            })),
        );
        assert!(host.run().await.is_err());
        f.assert_no_effects();
        assert_eq!(f.state()["curate"]["activeCategory"], "ARCHITECTURE");
        assert_eq!(f.state()["curate"]["cursor"], 0);
    }

    #[tokio::test]
    async fn dream_curate_expired_domain_at_commit_has_zero_effects() {
        let f = Fixture::new();
        let time = f.time.clone();
        let expiry = f.context.domain_lease.expires_at_ms;
        let (mut host, _) = f.host(
            Fixture::operations(),
            Some(Box::new(move || {
                time.0.store(expiry, Ordering::SeqCst);
            })),
        );
        assert!(host.run().await.is_err());
        f.assert_no_effects();
    }

    struct LoseTaskOnWrite {
        inner: SqliteContextDomain,
        control: Arc<Control>,
    }
    impl mc_store::ContextDomain for LoseTaskOnWrite {
        fn read(
            &self,
            read: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), mc_store::McStoreError> {
            self.inner.read(read)
        }
        fn write(
            &self,
            tables: &[&str],
            write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), mc_store::McStoreError> {
            self.inner.write(tables, &mut |tx| {
                if tables.contains(&"memories") {
                    self.control.0.store(true, Ordering::SeqCst);
                }
                write(tx)
            })
        }
    }
    #[tokio::test]
    async fn dream_curate_task_loss_inside_transaction_has_zero_effects() {
        let f = Fixture::new();
        f.store.install_context_domain(Arc::new(LoseTaskOnWrite {
            inner: SqliteContextDomain::open(&f.path).unwrap(),
            control: f.control.clone(),
        }));
        let (mut host, _) = f.host(Fixture::operations(), None);
        assert!(host.run().await.is_err());
        assert!(f.control.0.load(Ordering::SeqCst));
        f.assert_no_effects();
    }

    #[tokio::test]
    async fn dream_curate_second_effect_failure_rolls_back_entire_batch() {
        let f = Fixture::new();
        f.store.with_context_conn_for_test(|db| db.execute_batch("CREATE TRIGGER fail_curate_queue BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=2 BEGIN SELECT RAISE(ABORT,'second embedding failure'); END;")).unwrap();
        let (mut host, _) = f.host(
            vec![json!({"action":"archive","ids":[1,2],"superseded_by":6})],
            None,
        );
        assert!(host.run().await.is_err());
        f.assert_no_effects();
        assert_eq!(f.state()["curate"]["activeCategory"], "ARCHITECTURE");
    }

    #[tokio::test]
    async fn dream_curate_interrupted_restart_replays_receipts_without_reapplying() {
        let f = Fixture::new();
        f.store.with_context_conn_for_test(|db| db.execute_batch("CREATE TRIGGER fail_curate_merge BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=2 BEGIN SELECT RAISE(ABORT,'merge failure'); END;")).unwrap();
        let (mut first, _) = f.host(Fixture::operations(), None);
        assert!(first.run().await.is_err());
        drop(first);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history"), 1);
        assert_eq!(f.state()["curate"]["activeCategory"], "ARCHITECTURE");
        let descriptor = crate::dev_descriptor_at(f.dir.path().to_str().unwrap());
        let Fixture {
            dir,
            path,
            store,
            context,
            time,
            control,
        } = f;
        drop(store);
        let f = Fixture {
            dir,
            path,
            store: Arc::new(McStore::open_for_test(&descriptor).unwrap()),
            context,
            time,
            control,
        };
        f.store
            .with_context_conn_for_test(|db| db.execute_batch("DROP TRIGGER fail_curate_merge"))
            .unwrap();
        let (mut replay, _) = f.host(Fixture::operations(), None);
        replay.run().await.unwrap();
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history"), 6);
        assert_eq!(f.scalar("SELECT revision FROM memories WHERE id=1"), 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal"), 3);
        assert_eq!(f.state(), json!({"curate":{"cursor":2}}));
    }

    #[tokio::test]
    async fn dream_curate_receipt_replay_does_not_adopt_an_external_revision() {
        let f = Fixture::new();
        f.store.with_context_conn_for_test(|db| db.execute_batch("CREATE TRIGGER fail_curate_merge BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=2 BEGIN SELECT RAISE(ABORT,'merge failure'); END;")).unwrap();
        let (mut first, _) = f.host(Fixture::operations(), None);
        assert!(first.run().await.is_err());
        drop(first);
        f.store
            .with_context_conn_for_test(|db| db.execute_batch("DROP TRIGGER fail_curate_merge"))
            .unwrap();
        let store = f.store.clone();
        let operations = vec![
            Fixture::operations()[0].clone(),
            json!({"action":"update","ids":[1],"content":"This second attempted update must not overwrite an intervening external edit."}),
        ];
        let (mut replay, _) = f.host(operations, Some(Box::new(move || {
            store.with_context_conn_for_test(|db| db.execute_batch("UPDATE memories SET revision=revision+1,content='External latest content' WHERE id=1")).unwrap();
        })));
        let result = replay.run().await.unwrap();
        assert_eq!(result.completed_actions, ["update"]);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history"), 1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memories WHERE id=1 AND revision=3 AND content='External latest content'"), 1);
    }

    #[tokio::test]
    async fn dream_curate_merge_keeps_unknown_canonical_columns_and_history() {
        let f = Fixture::new();
        f.store.with_context_conn_for_test(|db| db.execute_batch("ALTER TABLE memories ADD COLUMN future_assessment TEXT; UPDATE memories SET future_assessment='critical',metadata_json='{\"unknownSafetyAssessment\":{\"critical\":true}}' WHERE id IN (2,3);")).unwrap();
        let (mut host, _) = f.host(vec![json!({"action":"merge","ids":[2,3],"content":"Architecture entry 2 describes the project's durable component boundary.","category":"ARCHITECTURE"})], None);
        host.run().await.unwrap();
        assert_eq!(
            f.scalar(
                "SELECT COUNT(*) FROM memories WHERE id IN (2,3) AND future_assessment='critical'"
            ),
            2
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history WHERE json_extract(before_json,'$.snapshot.future_assessment')='critical' AND json_extract(after_json,'$.snapshot.future_assessment')='critical'"), 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memories WHERE id=2 AND status='active' AND future_assessment='critical'"), 1);
    }

    #[tokio::test]
    async fn dream_curate_merge_refuses_loss_of_opaque_source_assessment() {
        for column in [true, false] {
            let f = Fixture::new();
            f.store.with_context_conn_for_test(|db| {
                if column {
                    db.execute_batch("ALTER TABLE memories ADD COLUMN future_assessment TEXT; UPDATE memories SET future_assessment='critical' WHERE id=3")
                } else {
                    db.execute_batch("UPDATE memories SET metadata_json='{\"future_assessment\":{\"critical\":true}}' WHERE id=3")
                }
            }).unwrap();
            let (mut host, _) = f.host(vec![Fixture::operations()[1].clone()], None);
            let error = host.run().await.unwrap_err();
            assert!(
                format!("{error:?}").contains("discard opaque memory field"),
                "{error:?}"
            );
            f.assert_no_effects();
        }
    }

    #[tokio::test]
    async fn dream_curate_restart_replay_has_no_second_effect() {
        let f = Fixture::new();
        let (mut host, _) = f.host(Fixture::operations(), None);
        host.run().await.unwrap();
        drop(host);
        let before = f.scalar("SELECT COUNT(*) FROM memory_history");
        let descriptor = crate::dev_descriptor_at(f.dir.path().to_str().unwrap());
        let Fixture {
            dir,
            path,
            store,
            context,
            time,
            control,
        } = f;
        drop(store);
        let f = Fixture {
            dir,
            path,
            store: Arc::new(McStore::open_for_test(&descriptor).unwrap()),
            context,
            time,
            control,
        };
        let (mut replay, _) = f.host(Vec::new(), None);
        let success = replay.run().await.unwrap();
        assert_eq!(success.completed_actions, ["update", "merge", "archive"]);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_history"), before);
        assert!(replay.carrier.inner.requests.lock().unwrap().is_empty());
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal"), 3);
        assert_eq!(f.state(), json!({"curate":{"cursor":2}}));
    }
}
