//! Off-thread classify/map execution over a fresh project snapshot.

use std::{
    collections::{BTreeSet, HashSet},
    path::PathBuf,
    process::Command,
    sync::Arc,
};

use mc_store::{
    dream_scheduler::schedules::TaskName, ClassificationUpdate, MappingUpdate, McStore,
    StoredMemoryFull,
};
use rusqlite::Transaction;

use super::{adapters::EmbeddingQueue, context::TaskContext};
use crate::{
    dream_runner::{Attempt, CarrierError, ChildRequest, Completion, DreamCarrier},
    dream_tasks::classify::{self, Memory, SensitiveContext, TaskError, TaskHost},
    memory_actions::{EmbeddingEffect, EmbeddingEffectKind, MemoryEmbeddingQueue},
};

#[derive(Debug)]
pub enum Outcome {
    Classify(Option<classify::ClassifyResult>),
    Map(Option<classify::MapResult>),
}

pub struct ClassifyHost<C: DreamCarrier> {
    carrier: C,
    store: Arc<McStore>,
    context: Arc<TaskContext>,
    tracked: HashSet<String>,
    root: Option<PathBuf>,
    attempts: Vec<Attempt>,
    map_attempted: BTreeSet<i64>,
}

impl<C> ClassifyHost<C>
where
    C: DreamCarrier,
{
    pub fn new(carrier: C, store: Arc<McStore>, context: Arc<TaskContext>) -> Self {
        Self {
            carrier,
            store,
            context,
            tracked: HashSet::new(),
            root: None,
            attempts: Vec::new(),
            map_attempted: BTreeSet::new(),
        }
    }

    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    pub fn map_attempted_ids(&self) -> &BTreeSet<i64> {
        &self.map_attempted
    }

    /// Dispatch classify-memories or map-memories using the captured task name.
    /// The scheduler must explicitly register this host before routing tasks here.
    pub async fn run(&mut self, sensitive: &SensitiveContext) -> Result<Outcome, TaskError> {
        let context = Arc::clone(&self.context);
        if !matches!(context.task, TaskName::Classify | TaskName::Map) {
            return Err(TaskError::Commit(
                "classify/map host received another task".into(),
            ));
        }
        if context.config.activated {
            self.check_control()?;
            if context.task == TaskName::Map {
                self.capture_paths()?;
            }
        }
        let active = if context.config.activated {
            self.store
                .load_dream_metadata(&context.scope.project.0)
                .map_err(|error| TaskError::Commit(error.to_string()))?
                .into_iter()
                .map(|row| Memory {
                    id: row.memory.id,
                    category: row.memory.category,
                    content: row.memory.content,
                    normalized_hash: row.memory.normalized_hash,
                    importance: row.memory.importance,
                    scope: Some(row.memory.scope),
                    shareable: row.memory.shareable != 0,
                    unclassified: row.unclassified,
                    open_classification: row.open_classification,
                    unmapped: row.files.is_empty() && !row.has_sentinel,
                    has_sentinel: row.has_sentinel,
                    files: row.files,
                    mapping_origin: row.mapping_origin,
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let task = classify::TaskContext {
            route_config: &context.config.route,
            trusted_config: &context.config.effective,
            harness: &context.config.harness,
            parent_session_id: &context.scope.session.0,
            directory: context.directory(),
            project: &context.scope.project.0,
            deadline_ms: context.deadline_ms.max(0) as u64,
            token_budget: context.task.default_budget(),
            sensitive,
        };
        match context.task {
            TaskName::Classify => {
                classify::run_classify(context.config.activated, &task, &active, self)
                    .await
                    .map(Outcome::Classify)
            }
            TaskName::Map => classify::run_map(context.config.activated, &task, &active, self)
                .await
                .map(Outcome::Map),
            _ => unreachable!("task checked before loading its snapshot"),
        }
    }

    fn capture_paths(&mut self) -> Result<(), TaskError> {
        let root = self
            .context
            .directory()
            .canonicalize()
            .map_err(|error| TaskError::Commit(error.to_string()))?;
        let output = Command::new("git")
            .args(["ls-files", "-z", "--cached"])
            .current_dir(&root)
            .output()
            .map_err(|error| TaskError::Commit(error.to_string()))?;
        if !output.status.success() {
            return Err(TaskError::Commit(
                "cannot read repository tracked paths".into(),
            ));
        }
        self.tracked = output
            .stdout
            .split(|byte| *byte == 0)
            .filter_map(|bytes| std::str::from_utf8(bytes).ok())
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        self.root = Some(root);
        Ok(())
    }

    fn normalized_path(&self, relative: &str) -> Option<String> {
        let path = relative.replace('\\', "/");
        let path = path.strip_prefix("./").unwrap_or(&path);
        if !self.tracked.contains(path) {
            return None;
        }
        let root = self.root.as_ref()?;
        let resolved = root.join(path).canonicalize().ok()?;
        (resolved.starts_with(root) && resolved.is_file()).then(|| path.to_owned())
    }

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

    fn enqueue(&self, tx: &Transaction<'_>, memory: &StoredMemoryFull) -> rusqlite::Result<()> {
        EmbeddingQueue.enqueue_tx(
            tx,
            &EmbeddingEffect {
                project_path: memory.project_path.clone(),
                session_id: self.context.scope.session.0.clone(),
                memory_id: memory.id,
                kind: EmbeddingEffectKind::Embed,
                content: Some(memory.content.clone()),
                content_hash: memory.normalized_hash.clone(),
                queued_at: self.context.now_ms(),
            },
        )
    }
}

impl<C> DreamCarrier for ClassifyHost<C>
where
    C: DreamCarrier,
{
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        self.carrier.open(request).await
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        self.carrier.complete(child, request).await
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        self.carrier.close(child, settled).await
    }
}

impl<C> TaskHost for ClassifyHost<C>
where
    C: DreamCarrier,
{
    fn check_control(&self) -> Result<(), TaskError> {
        self.context.check_control().map_err(|error| match error {
            super::context::ControlError::BudgetExhausted => TaskError::Budget,
            _ => TaskError::LeaseLost,
        })
    }
    fn now_ms(&self) -> u64 {
        self.context.now_ms().max(0) as u64
    }
    fn path_exists(&self, relative: &str) -> bool {
        self.normalized_path(relative).is_some()
    }
    fn normalize_files(&self, files: &[String]) -> Result<Vec<String>, String> {
        let mut seen = HashSet::new();
        Ok(files
            .iter()
            .filter_map(|path| self.normalized_path(path))
            .filter(|path| seen.insert(path.clone()))
            .collect())
    }
    fn budget_finalized(&self) -> bool {
        self.context
            .control
            .refuse_tool()
            .ok()
            .flatten()
            .is_some_and(|(_, finalize)| finalize)
    }
    fn record_attempts(&mut self, _task: &str, attempts: &[Attempt]) {
        self.attempts.extend_from_slice(attempts);
    }
    fn record_map_attempted(&mut self, ids: &[i64]) {
        self.map_attempted.extend(ids);
    }
    fn commit_classifications(
        &mut self,
        rows: &[ClassificationUpdate],
    ) -> Result<(usize, usize), TaskError> {
        self.store
            .commit_dream_classifications(
                &self.context.scope.project.0,
                rows,
                self.context.now_ms(),
                |tx| self.check_commit_fence(tx),
                |tx, memory| self.enqueue(tx, memory),
            )
            .map(|result| (result.accepted.len(), result.changed))
            .map_err(|error| TaskError::Commit(error.to_string()))
    }
    fn commit_mappings(&mut self, rows: &[MappingUpdate]) -> Result<Vec<i64>, TaskError> {
        self.store
            .commit_dream_mappings(
                &self.context.scope.project.0,
                rows,
                self.context.now_ms(),
                |tx| self.check_commit_fence(tx),
                |tx, memory| self.enqueue(tx, memory),
            )
            .map_err(|error| TaskError::Commit(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dream_dispatch::context::{
        Cancellation, CapturedConfig, Clock, ControlError, TaskControl,
    };
    use mc_store::parity_schema_manifest::{
        DreamLease, Generation, InvocationId, ProjectId, SessionId, StoreScope,
    };
    use mc_store::{dream_scheduler::budget::BudgetAction, SqliteContextDomain};
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

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

    struct FakeCarrier {
        answer: String,
        during_model: Option<Box<dyn FnOnce() + Send>>,
        requests: Vec<ChildRequest>,
    }
    impl DreamCarrier for FakeCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.requests.push(request.clone());
            Ok("child".into())
        }
        async fn complete(
            &mut self,
            _: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            if let Some(callback) = self.during_model.take() {
                callback();
            }
            assert!(
                !self.answer.is_empty(),
                "durable markers must avoid another model call"
            );
            Ok(Completion {
                text: self.answer.clone(),
                ..Completion::default()
            })
        }
        async fn close(&mut self, _: &str, _: bool) -> Result<(), CarrierError> {
            Ok(())
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        context_path: PathBuf,
        store: Arc<McStore>,
        context: Arc<TaskContext>,
        time: Arc<Time>,
        control: Arc<Control>,
    }
    impl Fixture {
        fn new(task: TaskName) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let cortexkit_store_types::StorageBackend::Sqlite { path } = &descriptor.backend else {
                panic!("fixture requires sqlite");
            };
            let context_path = PathBuf::from(path).with_file_name("context.db");
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let repo = dir.path().join("repo");
            std::fs::create_dir(&repo).unwrap();
            assert!(Command::new("git")
                .arg("init")
                .arg("--quiet")
                .current_dir(&repo)
                .status()
                .unwrap()
                .success());
            std::fs::write(repo.join("lib.rs"), "tracked source").unwrap();
            assert!(Command::new("git")
                .args(["add", "lib.rs"])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success());
            let time = Arc::new(Time(AtomicI64::new(1_000)));
            let control = Arc::new(Control::default());
            let scope = StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            };
            let domain_lease = store
                .acquire_dream_domain(&task.lease_key("project"), "holder", 1_000)
                .unwrap()
                .unwrap();
            let context = Arc::new(TaskContext {
                task,
                scope: scope.clone(),
                config: Arc::new(CapturedConfig {
                    activated: true,
                    route: crate::McModuleConfig::default(),
                    effective: json!({}),
                    harness: "opencode".into(),
                    directory: repo,
                }),
                domain_lease,
                task_lease: DreamLease {
                    scope,
                    invocation: InvocationId("invocation".into()),
                    token: "task-token".into(),
                    expires_at_ms: 2_000_000,
                },
                cancellation: Cancellation::default(),
                clock: time.clone(),
                deadline_ms: 2_000_000,
                control: control.clone(),
            });
            let fixture = Self {
                dir,
                context_path,
                store,
                context,
                time,
                control,
            };
            fixture.store.with_context_conn_for_test(|tx| {
                for id in 1..=11 {
                    let project = if id == 11 { "foreign" } else { "project" };
                    let content = format!("Memory {id} describes the implementation in `lib.rs`");
                    tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES (?1,?2,'PROJECT',?3,?4,'source-session',1,1,1,1)", params![id, project, content, mc_store::compute_normalized_memory_hash(&content)])?;
                    tx.execute("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES (?1,?2,'model')", params![id, vec![0_u8;8]])?;
                }
                tx.execute("INSERT INTO session_meta(session_id,served_prefix) VALUES ('session','frozen prefix'),('other-session','other prefix')", [])?;
                tx.execute("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES ('session','cached_m0_bytes',?1),('other-session','cached_m0_bytes',?2)", params![b"frozen bytes", b"other bytes"])?;
                tx.execute("INSERT INTO project_state(project_path,project_memory_epoch) VALUES ('project',7),('foreign',9)", [])?;
                Ok(())
            }).unwrap();
            fixture
        }

        fn carrier(&self) -> FakeCarrier {
            let answer = if self.context.task == TaskName::Classify {
                format!("<classify>{}</classify>", (1..=10).map(|id| format!("<memory id=\"{id}\" importance=\"80\" scope=\"project\" shareable=\"false\" />")).collect::<String>())
            } else {
                format!(
                    "<mappings>{}</mappings>",
                    (1..=10)
                        .map(|id| format!("<memory id=\"{id}\" files=\"lib.rs\" />"))
                        .collect::<String>()
                )
            };
            FakeCarrier {
                answer,
                during_model: None,
                requests: Vec::new(),
            }
        }

        fn scalar(&self, sql: &str) -> i64 {
            self.store
                .with_context_read(|db| db.query_row(sql, [], |row| row.get(0)))
                .unwrap()
        }
        fn assert_no_effect(&self) {
            assert_eq!(
                self.scalar("SELECT COUNT(*) FROM memories WHERE classified_at IS NOT NULL"),
                0
            );
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_verifications"), 0);
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_embeddings"), 11);
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_history"), 0);
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_mutation_log"), 0);
        }
    }

    #[tokio::test]
    async fn classify_and_map_run_real_store_and_preserve_served_sessions() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let before = fixture.store.with_context_read(|db| {
                db.prepare("SELECT session_id,served_prefix,(SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes') FROM session_meta ORDER BY session_id")?
                    .query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Vec<u8>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()
            }).unwrap();
            let mut host = ClassifyHost::new(
                fixture.carrier(),
                fixture.store.clone(),
                fixture.context.clone(),
            );
            let outcome = host.run(&SensitiveContext::default()).await.unwrap();
            match outcome {
                Outcome::Classify(Some(result)) => {
                    assert_eq!(result.classified, 10);
                    assert_eq!(result.changed, 10);
                }
                Outcome::Map(Some(result)) => {
                    assert_eq!(result.mapped, 10);
                    assert!(result.complete);
                }
                _ => panic!("task did not run"),
            }
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_embeddings"), 1);
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memories WHERE project_path='foreign' AND classified_at IS NOT NULL"), 0);
            assert_eq!(
                fixture.scalar("SELECT COUNT(*) FROM memory_verifications WHERE memory_id=11"),
                0
            );
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_history"), 0);
            assert_eq!(
                fixture.scalar("SELECT COUNT(*) FROM memory_mutation_log"),
                0
            );
            assert_eq!(
                fixture.scalar(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path='project'"
                ),
                7
            );
            assert_eq!(
                fixture.scalar(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path='foreign'"
                ),
                9
            );
            let after = fixture.store.with_context_read(|db| {
                db.prepare("SELECT session_id,served_prefix,(SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes') FROM session_meta ORDER BY session_id")?
                    .query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,Vec<u8>>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()
            }).unwrap();
            assert_eq!(before, after);
            let request = &host.carrier.requests[0];
            assert_eq!(request.parent_session_id, "session");
            assert_eq!(request.directory, fixture.context.config.directory);
            assert!(!request.prompt.contains("Memory 11"));
        }
    }

    #[tokio::test]
    async fn classify_and_map_stolen_domain_at_commit_has_zero_effects() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let mut carrier = fixture.carrier();
            let store = fixture.store.clone();
            let lease = fixture.context.domain_lease.clone();
            carrier.during_model = Some(Box::new(move || {
                assert!(store.release_dream_domain(&lease).unwrap());
                store
                    .acquire_dream_domain(&lease.key, "successor", 1_001)
                    .unwrap()
                    .unwrap();
            }));
            let mut host =
                ClassifyHost::new(carrier, fixture.store.clone(), fixture.context.clone());
            let outcome = host.run(&SensitiveContext::default()).await;
            assert!(outcome.is_err(), "{task:?}: {outcome:?}");
            fixture.assert_no_effect();
        }
    }

    #[tokio::test]
    async fn classify_and_map_stale_prompt_hashes_are_not_applied() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let mut carrier = fixture.carrier();
            let store = fixture.store.clone();
            carrier.during_model = Some(Box::new(move || {
                store.with_context_conn_for_test(|tx| {
                    tx.execute("UPDATE memories SET content='changed during prompt',normalized_hash=?1 WHERE id=1", [mc_store::compute_normalized_memory_hash("changed during prompt")])?;
                    Ok(())
                }).unwrap();
            }));
            let mut host =
                ClassifyHost::new(carrier, fixture.store.clone(), fixture.context.clone());
            match host.run(&SensitiveContext::default()).await.unwrap() {
                Outcome::Classify(Some(result)) => assert_eq!(result.classified, 9),
                Outcome::Map(Some(result)) => assert_eq!(result.mapped, 9),
                _ => panic!("task did not run"),
            }
            assert_eq!(
                fixture.scalar(
                    "SELECT COUNT(*) FROM memories WHERE id=1 AND classified_at IS NOT NULL"
                ),
                0
            );
            assert_eq!(
                fixture.scalar("SELECT COUNT(*) FROM memory_verifications WHERE memory_id=1"),
                0
            );
            assert_eq!(
                fixture.scalar("SELECT COUNT(*) FROM memory_embeddings WHERE memory_id=1"),
                1
            );
        }
    }

    #[tokio::test]
    async fn classify_and_map_expired_domain_at_commit_has_zero_effects() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let mut carrier = fixture.carrier();
            let time = fixture.time.clone();
            let expiry = fixture.context.domain_lease.expires_at_ms;
            carrier.during_model = Some(Box::new(move || {
                time.0.store(expiry, Ordering::SeqCst);
            }));
            let mut host =
                ClassifyHost::new(carrier, fixture.store.clone(), fixture.context.clone());
            let _ = host.run(&SensitiveContext::default()).await;
            fixture.assert_no_effect();
        }
    }

    struct LoseTaskOnWrite {
        inner: SqliteContextDomain,
        armed: Arc<AtomicBool>,
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
                if self.armed.load(Ordering::SeqCst) {
                    self.control.0.store(true, Ordering::SeqCst);
                }
                write(tx)
            })
        }
    }

    #[tokio::test]
    async fn classify_and_map_task_loss_inside_transaction_has_zero_effects() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let armed = Arc::new(AtomicBool::new(false));
            fixture
                .store
                .install_context_domain(Arc::new(LoseTaskOnWrite {
                    inner: SqliteContextDomain::open(&fixture.context_path).unwrap(),
                    armed: armed.clone(),
                    control: fixture.control.clone(),
                }));
            let mut carrier = fixture.carrier();
            carrier.during_model = Some(Box::new(move || {
                armed.store(true, Ordering::SeqCst);
            }));
            let mut host =
                ClassifyHost::new(carrier, fixture.store.clone(), fixture.context.clone());
            let outcome = host.run(&SensitiveContext::default()).await;
            assert!(
                fixture.control.0.load(Ordering::SeqCst),
                "{task:?}: {outcome:?}"
            );
            fixture.assert_no_effect();
        }
    }

    #[tokio::test]
    async fn classify_and_map_queue_failure_rolls_back_the_whole_batch() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            fixture.store.with_context_conn_for_test(|tx| tx.execute_batch(
                "CREATE TRIGGER fail_embedding_delete BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=2 BEGIN SELECT RAISE(ABORT,'embedding failure'); END;"
            )).unwrap();
            let mut host = ClassifyHost::new(
                fixture.carrier(),
                fixture.store.clone(),
                fixture.context.clone(),
            );
            let _ = host.run(&SensitiveContext::default()).await;
            fixture.assert_no_effect();
        }
    }

    #[tokio::test]
    async fn classify_and_map_durable_markers_prevent_replay_after_reopen() {
        for task in [TaskName::Classify, TaskName::Map] {
            let fixture = Fixture::new(task);
            let mut host = ClassifyHost::new(
                fixture.carrier(),
                fixture.store.clone(),
                fixture.context.clone(),
            );
            host.run(&SensitiveContext::default()).await.unwrap();
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_embeddings"), 1);
            drop(host);
            let Fixture {
                dir,
                store,
                context,
                ..
            } = fixture;
            drop(store);
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let carrier = FakeCarrier {
                answer: String::new(),
                during_model: None,
                requests: Vec::new(),
            };
            let mut host = ClassifyHost::new(carrier, store, context);
            match host.run(&SensitiveContext::default()).await.unwrap() {
                Outcome::Classify(Some(result)) => {
                    assert_eq!(result.classified, 0);
                    assert!(result.complete);
                }
                Outcome::Map(Some(result)) => {
                    assert_eq!(result.mapped, 0);
                    assert!(result.complete);
                }
                _ => panic!("task did not run"),
            }
            assert!(host.carrier.requests.is_empty());
        }
    }

    #[test]
    fn map_paths_reject_untracked_traversal_and_symlink_escape() {
        let fixture = Fixture::new(TaskName::Map);
        let root = fixture.context.directory();
        std::fs::write(root.join("untracked.rs"), "untracked").unwrap();
        #[cfg(unix)]
        {
            let outside = fixture.dir.path().join("outside.rs");
            std::fs::write(&outside, "outside").unwrap();
            std::os::unix::fs::symlink(outside, root.join("escape.rs")).unwrap();
            assert!(Command::new("git")
                .args(["add", "escape.rs"])
                .current_dir(root)
                .status()
                .unwrap()
                .success());
        }
        let mut host = ClassifyHost::new(
            fixture.carrier(),
            fixture.store.clone(),
            fixture.context.clone(),
        );
        host.capture_paths().unwrap();
        let files = [
            "lib.rs",
            "./lib.rs",
            "untracked.rs",
            "../outside.rs",
            "escape.rs",
        ]
        .map(str::to_owned);
        assert_eq!(host.normalize_files(&files).unwrap(), ["lib.rs"]);
    }
}
