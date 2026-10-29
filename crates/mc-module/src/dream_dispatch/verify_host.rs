//! Verify memories against source code off-thread; recheck leases and source
//! hashes before committing results, archive history, undo and vector changes.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::Duration,
};

use mc_store::{
    dream_scheduler::schedules::TaskName,
    dream_verify::{VerifyBatchKind, VerifyIdentity, VerifyMemory},
    McStore,
};
use rusqlite::Transaction;

use super::{adapters::EmbeddingQueue, context::TaskContext};
use crate::{
    dream_runner::{self, Attempt, DreamCarrier, DreamRequest, DreamRole, Failure},
    dream_tasks::verify::{self, Changes, Memory, Verdict},
    memory_actions::{
        EmbeddingEffect, EmbeddingEffectKind, MemoryActionContext, MemoryEmbeddingQueue, MemoryRole,
    },
};

#[derive(Debug)]
pub struct Outcome {
    pub expired: usize,
    pub verification: verify::RunResult,
}

pub struct VerifyHost<C: DreamCarrier> {
    carrier: C,
    store: Arc<McStore>,
    context: Arc<TaskContext>,
    tracked: HashSet<String>,
    root: Option<PathBuf>,
    attempts: Vec<Attempt>,
}

impl<C: DreamCarrier> VerifyHost<C> {
    pub fn new(carrier: C, store: Arc<McStore>, context: Arc<TaskContext>) -> Self {
        Self {
            carrier,
            store,
            context,
            tracked: HashSet::new(),
            root: None,
            attempts: Vec::new(),
        }
    }

    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    /// The scheduler supplies the durable broad-cycle start on every resumed run.
    /// Registration and broad-cycle advancement remain the scheduler's concern.
    pub async fn run(&mut self, broad_start: Option<i64>) -> Result<Option<Outcome>, String> {
        let context = Arc::clone(&self.context);
        if !matches!(context.task, TaskName::Verify | TaskName::VerifyBroad) {
            return Err("verify host received another task".into());
        }
        if !context.config.activated {
            return Ok(None);
        }
        context
            .check_control()
            .map_err(|error| format!("{error:?}"))?;
        self.capture_paths()?;
        let identity = VerifyIdentity {
            project: &context.scope.project.0,
            session: &context.scope.session.0,
            harness: &context.config.harness,
            invocation: &context.task_lease.invocation.0,
        };
        let snapshot = self
            .store
            .load_dream_verify(&identity)
            .map_err(|error| error.to_string())?;
        let expired = self.expire(&snapshot)?;
        let snapshot: Vec<_> = snapshot
            .into_iter()
            .filter(|row| {
                !row.decided && row.memory.expires_at.is_none_or(|at| at > context.now_ms())
            })
            .collect();
        let pool: Vec<_> = snapshot.iter().map(planning_memory).collect();
        let changes = self.changes(&pool);
        let broad_start = if context.task == TaskName::VerifyBroad {
            Some(broad_start.unwrap_or(context.now_ms()))
        } else {
            None
        };
        let scope = verify::partition(&pool, &changes, broad_start);
        let batches = verify::batches(&pool, &scope);
        let mut result = verify::RunResult {
            counts: verify::Counts::default(),
            batches: 0,
            in_scope: scope.selected.len(),
            remaining: scope.selected.len(),
            complete: true,
            mode: scope.mode,
            broad_cycle_start: broad_start,
            stop_reason: None,
        };
        if !scope.unmapped.is_empty() {
            let batch: Vec<_> = scope
                .unmapped
                .iter()
                .map(|index| pool[*index].clone())
                .collect();
            let verdicts: Vec<_> = batch
                .iter()
                .map(|memory| Verdict {
                    id: memory.id,
                    kind: "unmapped".into(),
                    files: vec![],
                    content: String::new(),
                    reason: String::new(),
                    consolidation: false,
                })
                .collect();
            let head = self.head();
            self.commit_verify_batch(
                &snapshot,
                &batch,
                &verdicts,
                head.as_deref(),
                head.as_deref(),
            )?;
        }
        let mut prior_failure = None;
        let mut last_failure = None;
        for (index, batch) in batches.iter().enumerate() {
            context
                .check_control()
                .map_err(|error| format!("{error:?}"))?;
            let remaining = context.deadline_ms.saturating_sub(context.now_ms()).max(0);
            if remaining < verify::BATCH_FLOOR_MS {
                result.stop_reason = Some("deadline");
                break;
            }
            let head = self.head();
            let evidence =
                if broad_start.is_none() && batch.iter().all(|memory| memory.verified_at > 0) {
                    self.evidence(batch)
                } else {
                    None
                };
            let request = verify::BatchRequest {
                batch,
                slice_ms: verify::batch_slice_ms(remaining, batches.len() - index),
                system: verify::system_prompt()?,
                prompt: verify::build_prompt_with_mode(
                    &context.scope.project.0,
                    batch,
                    evidence.as_ref(),
                    if broad_start.is_some() {
                        "broad"
                    } else {
                        "full"
                    },
                )?,
            };
            let completion = self.resolve_completion(request).await?;
            result.batches += 1;
            if completion.timed_out {
                result.stop_reason = Some("batch-timeout");
                break;
            }
            if let Some(failure) = completion.provider_failure {
                if prior_failure.as_ref() == Some(&failure) {
                    return Err(failure);
                }
                prior_failure = Some(failure.clone());
                last_failure = Some(failure);
                continue;
            }
            prior_failure = None;
            let mut verdicts =
                verify::parse_manifest(&completion.manifest, batch, completion.budget_finalized)?;
            for verdict in &mut verdicts {
                if matches!(verdict.kind.as_str(), "archive" | "skipped") {
                    verdict.files = batch
                        .iter()
                        .find(|memory| memory.id == verdict.id)
                        .unwrap()
                        .files
                        .clone();
                }
                let mut seen = HashSet::new();
                verdict.files = verdict
                    .files
                    .iter()
                    .filter_map(|path| self.normalized_path(path))
                    .filter(|path| seen.insert(path.clone()))
                    .collect();
            }
            let current = self.head();
            let counts = self.commit_verify_batch(
                &snapshot,
                batch,
                &verdicts,
                head.as_deref(),
                current.as_deref(),
            )?;
            result.remaining = result.remaining.saturating_sub(
                counts.verified
                    + counts.updated
                    + counts.archived
                    + counts.skipped
                    + counts.refused,
            );
            result.counts.verified += counts.verified;
            result.counts.updated += counts.updated;
            result.counts.archived += counts.archived;
            result.counts.skipped += counts.skipped;
            result.counts.refused += counts.refused;
        }
        if let Some(failure) = last_failure {
            return Err(failure);
        }
        result.complete = result.remaining == 0;
        Ok(Some(Outcome {
            expired,
            verification: result,
        }))
    }

    /// Resolve the runner asynchronously before using the synchronous planner's
    /// Completion value. No store reader, writer or transaction spans this await.
    async fn resolve_completion(
        &mut self,
        batch: verify::BatchRequest<'_>,
    ) -> Result<verify::Completion, String> {
        let context = Arc::clone(&self.context);
        // Verification uses the mapper's read-only tools and step cap, matching
        // DREAMER_MEMORY_MAPPER_AGENT in both TypeScript verification paths:
        // packages/plugin/src/features/magic-context/dreamer/verify.ts:352,411.
        let request = DreamRequest {
            task: context.task.as_str(),
            role: DreamRole::MemoryMapper,
            harness: &context.config.harness,
            parent_session_id: &context.scope.session.0,
            directory: context.directory(),
            system: batch.system,
            prompt: &batch.prompt,
            timeout: Duration::from_millis(batch.slice_ms.max(1) as u64),
            token_budget: context.task.default_budget(),
            allow_empty: false,
        };
        let control = Arc::clone(&context.control);
        let report = dream_runner::run_dream_task(
            context.config.activated,
            &context.config.route,
            &context.config.effective,
            &request,
            &mut self.carrier,
            |completion| {
                let finalized = control
                    .refuse_tool()
                    .map_err(|error| format!("{error:?}"))?
                    .is_some_and(|(_, finalize)| finalize);
                verify::parse_manifest(&completion.text, batch.batch, finalized)?;
                Ok((completion.text.clone(), finalized))
            },
        )
        .await;
        self.attempts.extend(report.attempts);
        let mut completion = verify::Completion {
            manifest: String::new(),
            timed_out: false,
            provider_failure: None,
            budget_finalized: false,
        };
        match report.result {
            Ok((manifest, finalized)) => {
                completion.manifest = manifest;
                completion.budget_finalized = finalized;
            }
            Err(Failure::Timeout) => completion.timed_out = true,
            Err(Failure::Open(error) | Failure::Transport(error)) => {
                completion.provider_failure = Some(error)
            }
            Err(error) => return Err(format!("{error:?}")),
        }
        Ok(completion)
    }

    fn action_context<'a>(&'a self, decision_key: &'a str) -> MemoryActionContext<'a> {
        MemoryActionContext {
            project_path: &self.context.scope.project.0,
            session_id: &self.context.scope.session.0,
            harness: &self.context.config.harness,
            role: MemoryRole::Dreamer,
            workspace_members: &[],
            shared_categories: &[],
            curate_category: None,
            memory_enabled: true,
            now_ms: self.context.now_ms(),
            decision_key,
        }
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

    fn commit_verify_batch(
        &self,
        snapshot: &[VerifyMemory],
        batch: &[Memory],
        verdicts: &[Verdict],
        checked: Option<&str>,
        current: Option<&str>,
    ) -> Result<verify::Counts, String> {
        let rows: Vec<_> = snapshot
            .iter()
            .filter(|row| batch.iter().any(|memory| memory.id == row.memory.id))
            .cloned()
            .collect();
        self.store
            .commit_dream_verify(
                &self.context.scope.project.0,
                &rows,
                VerifyBatchKind::Verify,
                self.context.now_ms(),
                |tx| self.check_commit_fence(tx),
                |tx, accepted| {
                    let accepted: HashSet<_> = accepted.iter().map(|row| row.memory.id).collect();
                    let verdicts: Vec<_> = verdicts
                        .iter()
                        .filter(|verdict| accepted.contains(&verdict.id))
                        .cloned()
                        .collect();
                    verify::execute_tx(
                        tx,
                        &EmbeddingQueue,
                        &self.action_context(&self.context.task_lease.invocation.0),
                        batch,
                        &verdicts,
                        checked,
                        current,
                    )
                },
            )
            .map_err(|error| error.to_string())
    }

    fn expire(&self, snapshot: &[VerifyMemory]) -> Result<usize, String> {
        let rows: Vec<_> = snapshot
            .iter()
            .filter(|row| {
                row.memory.status == "active"
                    && row
                        .memory
                        .expires_at
                        .is_some_and(|at| at <= self.context.now_ms())
            })
            .cloned()
            .collect();
        let mut count = 0;
        // Even an empty probe enters the writer so lease loss is not hidden by
        // an empty backlog. The store composes the automated TTL archive and undo.
        for batch in rows.chunks(100).chain(rows.is_empty().then_some(&[][..])) {
            count += self
                .store
                .commit_dream_expiry(
                    &self.context.scope.project.0,
                    batch,
                    self.context.now_ms(),
                    |tx| self.check_commit_fence(tx),
                    |tx, memory| {
                        EmbeddingQueue.enqueue_tx(
                            tx,
                            &EmbeddingEffect {
                                project_path: memory.project_path.clone(),
                                session_id: self.context.scope.session.0.clone(),
                                memory_id: memory.id,
                                kind: EmbeddingEffectKind::Invalidate,
                                content: None,
                                content_hash: memory.normalized_hash.clone(),
                                queued_at: self.context.now_ms(),
                            },
                        )
                    },
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(count)
    }

    fn git(&self, args: &[&str]) -> Option<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(self.root.as_ref()?)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).ok())
            .flatten()
    }

    fn head(&self) -> Option<String> {
        self.git(&["rev-parse", "HEAD"])
            .map(|text| text.trim().to_owned())
    }

    fn capture_paths(&mut self) -> Result<(), String> {
        self.root = Some(
            self.context
                .directory()
                .canonicalize()
                .map_err(|error| error.to_string())?,
        );
        let output = self
            .git(&["ls-files", "-z", "--cached"])
            .ok_or("cannot read repository tracked paths")?;
        self.tracked = output
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
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

    fn changes(&self, pool: &[Memory]) -> Changes {
        let mut changes = Changes::default();
        let mut times = BTreeMap::new();
        let files: BTreeSet<_> = pool.iter().flat_map(|memory| memory.files.iter()).collect();
        for file in files {
            if self.normalized_path(file).is_none() {
                changes.missing.insert(file.clone());
            }
            let Some(at) = self
                .git(&["log", "-1", "--format=%ct", "--", file])
                .and_then(|text| text.trim().parse::<i64>().ok())
            else {
                return changes;
            };
            times.insert(file.clone(), at.saturating_mul(1_000));
        }
        let Some(dirty) = self.git(&["diff", "--name-only", "-z", "HEAD", "--"]) else {
            return changes;
        };
        changes.uncommitted = dirty
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_owned)
            .collect();
        changes.committed_at = Some(times);
        changes
    }

    fn evidence(&self, batch: &[Memory]) -> Option<verify::DiffEvidence> {
        let mut files = BTreeMap::<String, Vec<&Memory>>::new();
        for memory in batch {
            for path in &memory.files {
                files.entry(path.clone()).or_default().push(memory);
            }
        }
        let mut evidence = Vec::new();
        for (path, memories) in files {
            let earliest = memories.iter().min_by_key(|memory| memory.verified_at)?;
            let base = earliest.verified_commit.as_deref()?;
            let text = self.git(&["diff", base, "--", &path])?;
            evidence.push(verify::EvidenceFile {
                path,
                text,
                memory_ids: memories.iter().map(|memory| memory.id).collect(),
            });
        }
        Some(verify::bounded_evidence(self.head()?, evidence))
    }
}

fn planning_memory(row: &VerifyMemory) -> Memory {
    Memory {
        id: row.memory.id,
        category: row.memory.category.clone(),
        content: row.memory.content.clone(),
        revision: row.revision,
        content_hash: row.memory.normalized_hash.clone(),
        files: row.files.clone(),
        verified_at: row.verified_at,
        verified_commit: row.verified_commit.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dream_dispatch::context::{
        Cancellation, CapturedConfig, Clock, ControlError, TaskControl,
    };
    use crate::dream_runner::{CarrierError, ChildRequest, Completion};
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
        closed: usize,
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
                "durable verification receipts must prevent replay model calls"
            );
            Ok(Completion {
                text: self.answer.clone(),
                ..Completion::default()
            })
        }
        async fn close(&mut self, _: &str, _: bool) -> Result<(), CarrierError> {
            self.closed += 1;
            Ok(())
        }
    }
    fn memory_row(db: &Connection, id: i64) -> serde_json::Value {
        let mut statement = db.prepare("SELECT * FROM memories WHERE id=?1").unwrap();
        let names: Vec<_> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        statement
            .query_row([id], |row| {
                let mut result = serde_json::Map::new();
                for (index, name) in names.iter().enumerate() {
                    let value = match row.get_ref(index)? {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(value) => json!(value),
                        rusqlite::types::ValueRef::Real(value) => json!(value),
                        rusqlite::types::ValueRef::Text(value) => {
                            json!(std::str::from_utf8(value).unwrap())
                        }
                        rusqlite::types::ValueRef::Blob(_) => panic!("unexpected memory blob"),
                    };
                    result.insert(name.clone(), value);
                }
                Ok(serde_json::Value::Object(result))
            })
            .unwrap()
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
            let root = std::env::temp_dir().join("magic-context/i5-5b");
            std::fs::create_dir_all(&root).unwrap();
            let dir = tempfile::tempdir_in(root).unwrap();
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let cortexkit_store_types::StorageBackend::Sqlite { path } = &descriptor.backend else {
                panic!("sqlite required")
            };
            let context_path = PathBuf::from(path).with_file_name("context.db");
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let repo = dir.path().join("repo");
            std::fs::create_dir(&repo).unwrap();
            assert!(Command::new("git")
                .args(["init", "--quiet"])
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
            assert!(Command::new("git")
                .args([
                    "-c",
                    "user.name=Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "commit",
                    "--quiet",
                    "-m",
                    "source"
                ])
                .current_dir(&repo)
                .status()
                .unwrap()
                .success());
            let time = Arc::new(Time(AtomicI64::new(10_000)));
            let control = Arc::new(Control::default());
            let scope = StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            };
            let domain_lease = store
                .acquire_dream_domain(&task.lease_key("project"), "holder", 10_000)
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
            store.with_context_conn_for_test(|tx| {
                for id in 1..=4 {
                    let content = format!("Memory {id} describes implementation in lib.rs");
                    tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,'PROJECT_RULES',?3,?4,'source',1,1,1,1)", params![id, if id==4 {"foreign"} else {"project"}, content, mc_store::compute_normalized_memory_hash(&content)])?;
                    tx.execute("INSERT INTO memory_verifications(memory_id,file_path,verified_at,mapped_at,mapping_origin) VALUES(?1,'lib.rs',0,1,'mapper')", [id])?;
                    tx.execute("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(?1,?2,'model')", params![id,vec![0_u8;8]])?;
                }
                tx.execute("INSERT INTO session_meta(session_id,served_prefix) VALUES ('session','frozen prefix')", [])?;
                tx.execute("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES ('session','cached_m0_bytes',?1)", [b"frozen bytes"])?;
                tx.execute("INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project',7)", [])?;
                Ok(())
            }).unwrap();
            Self {
                dir,
                context_path,
                store,
                context,
                time,
                control,
            }
        }
        fn carrier(&self) -> FakeCarrier {
            FakeCarrier { answer: "<verify><verified id=\"1\" files=\"lib.rs\"/><update id=\"2\" files=\"lib.rs\">Memory 2 describes the corrected implementation in lib.rs</update><archive id=\"3\" reason=\"contradicted by source\"/></verify>".into(), during_model: None, requests: Vec::new(), closed: 0 }
        }
        fn host(&self, carrier: FakeCarrier) -> VerifyHost<FakeCarrier> {
            VerifyHost::new(carrier, self.store.clone(), self.context.clone())
        }
        fn scalar(&self, sql: &str) -> i64 {
            self.store
                .with_context_read(|db| db.query_row(sql, [], |row| row.get(0)))
                .unwrap()
        }
        fn assert_no_effect(&self) {
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memories WHERE verified_at IS NOT NULL OR status='archived' OR revision!=1"), 0);
            assert_eq!(
                self.scalar("SELECT COUNT(*) FROM memory_verifications WHERE verified_at!=0"),
                0
            );
            assert_eq!(self.scalar("SELECT COUNT(*) FROM memory_embeddings"), 4);
            for table in [
                "memory_history",
                "memory_journal",
                "memory_decision_receipts",
                "memory_mutation_log",
            ] {
                assert_eq!(
                    self.scalar(&format!("SELECT COUNT(*) FROM {table}")),
                    0,
                    "{table}"
                );
            }
        }
    }

    #[tokio::test]
    async fn dream_verify_real_host_verified_contradicted_updated_and_frozen_prefix() {
        for task in [TaskName::Verify, TaskName::VerifyBroad] {
            let fixture = Fixture::new(task);
            let mut host = fixture.host(fixture.carrier());
            let result = host.run(Some(10_000)).await.unwrap().unwrap();
            assert_eq!(
                result.verification.counts,
                verify::Counts {
                    verified: 1,
                    updated: 1,
                    archived: 1,
                    ..verify::Counts::default()
                }
            );
            assert!(result.verification.complete);
            assert_eq!(result.expired, 0);
            assert_eq!(host.attempts().len(), 1);
            assert_eq!(host.carrier.closed, 1);
            let request = &host.carrier.requests[0];
            assert_eq!(request.agent, "dreamer-memory-mapper");
            assert_eq!(request.parent_session_id, "session");
            assert_eq!(request.directory, fixture.context.config.directory);
            assert!(!request.prompt.contains("Memory 4"));
            assert!(request.allowed_tools.contains(&"read"));
            assert!(!request.allowed_tools.contains(&"ctx_memory"));
            assert_eq!(
                fixture.scalar("SELECT verified_at FROM memories WHERE id=1"),
                10_000
            );
            assert_eq!(
                fixture
                    .scalar("SELECT COUNT(*) FROM memories WHERE id=2 AND verify_result='updated'"),
                1
            );
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memories WHERE id=3 AND status='archived' AND verify_result='archived'"), 1);
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_history"), 2);
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_embeddings"), 2);
            assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memories WHERE id=4 AND revision=1 AND verified_at IS NULL"), 1);
            fixture.store.with_context_read(|db| {
                let (prefix, bytes): (String, Vec<u8>) = db.query_row("SELECT served_prefix,(SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes') FROM session_meta WHERE session_id='session'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
                assert_eq!(prefix, "frozen prefix"); assert_eq!(bytes, b"frozen bytes");
                assert_eq!(db.query_row("SELECT COUNT(*) FROM memory_journal WHERE operation='verification' AND json_extract(after_json,'$.checkedCommit') IS NOT NULL", [], |row| row.get::<_, i64>(0))?, 3);
                Ok(())
            }).unwrap();
            assert_eq!(
                fixture.scalar(
                    "SELECT project_memory_epoch FROM project_state WHERE project_path='project'"
                ),
                7
            );
        }
    }

    #[tokio::test]
    async fn dream_verify_expiry_is_audited_with_undo_and_queue() {
        let fixture = Fixture::new(TaskName::Verify);
        fixture
            .store
            .with_context_conn_for_test(|tx| {
                tx.execute(
                    "UPDATE memories SET expires_at=10000 WHERE id IN (1,2,4)",
                    [],
                )?;
                tx.execute(
                    "UPDATE memories SET status='permanent',expires_at=10000 WHERE id=3",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let before = fixture
            .store
            .with_context_read(|db| Ok(memory_row(db, 1)))
            .unwrap();
        let mut carrier = fixture.carrier();
        carrier.answer.clear();
        let mut host = fixture.host(carrier);
        assert_eq!(host.run(None).await.unwrap().unwrap().expired, 2);
        assert!(host.carrier.requests.is_empty());
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_history WHERE reason='expired' AND before_json IS NOT NULL AND after_json IS NOT NULL"), 2);
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_journal WHERE before_json IS NOT NULL AND after_json IS NOT NULL"), 2);
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_embeddings"), 2);
        assert_eq!(
            fixture
                .scalar("SELECT COUNT(*) FROM memories WHERE id IN (3,4) AND status!='archived'"),
            2
        );
        fixture.store.with_context_read(|db| {
            let (before_json, after_json): (String, String) = db.query_row("SELECT before_json,after_json FROM memory_journal WHERE decision_key='expire:1:1'", [], |row| Ok((row.get(0)?, row.get(1)?)))?;
            let saved_before: serde_json::Value = serde_json::from_str(&before_json).unwrap();
            let saved_after: serde_json::Value = serde_json::from_str(&after_json).unwrap();
            assert_eq!(saved_before["rows"][0]["before"], mc_store::memory_history::normalize_snapshot(&before, Some(1)).unwrap());
            let after = memory_row(db, 1);
            assert_eq!(saved_after, saved_before);
            assert_eq!(saved_after["rows"][0]["after"], mc_store::memory_history::normalize_snapshot(&after, Some(2)).unwrap());
            assert_eq!(after["status"], "archived");
            assert_eq!(after["revision"], 2);
            assert_eq!(after["content"], before["content"]);
            assert_eq!(db.query_row("SELECT COUNT(*) FROM memory_verifications WHERE memory_id=1", [], |row| row.get::<_, i64>(0))?, 1);
            Ok(())
        }).unwrap();
        assert_eq!(
            fixture.scalar("SELECT COUNT(*) FROM memory_mutation_log"),
            0
        );
    }

    #[tokio::test]
    async fn dream_verify_stolen_domain_at_commit_has_zero_effects() {
        let fixture = Fixture::new(TaskName::Verify);
        let mut carrier = fixture.carrier();
        let store = fixture.store.clone();
        let lease = fixture.context.domain_lease.clone();
        carrier.during_model = Some(Box::new(move || {
            assert!(store.release_dream_domain(&lease).unwrap());
            store
                .acquire_dream_domain(&lease.key, "successor", 10_001)
                .unwrap()
                .unwrap();
        }));
        assert!(fixture.host(carrier).run(None).await.is_err());
        fixture.assert_no_effect();
    }

    #[tokio::test]
    async fn dream_verify_expired_domain_at_commit_has_zero_effects() {
        let fixture = Fixture::new(TaskName::Verify);
        let mut carrier = fixture.carrier();
        let time = fixture.time.clone();
        let expiry = fixture.context.domain_lease.expires_at_ms;
        carrier.during_model = Some(Box::new(move || {
            time.0.store(expiry, Ordering::SeqCst);
        }));
        assert!(fixture.host(carrier).run(None).await.is_err());
        fixture.assert_no_effect();
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
    async fn dream_verify_task_loss_inside_transaction_has_zero_effects() {
        let fixture = Fixture::new(TaskName::Verify);
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
        assert!(fixture.host(carrier).run(None).await.is_err());
        assert!(fixture.control.0.load(Ordering::SeqCst));
        fixture.assert_no_effect();
    }

    #[tokio::test]
    async fn dream_verify_prompt_hash_drift_refuses_even_a_receipt() {
        let fixture = Fixture::new(TaskName::Verify);
        let mut carrier = fixture.carrier();
        let store = fixture.store.clone();
        carrier.during_model = Some(Box::new(move || {
            store.with_context_conn_for_test(|tx| { tx.execute("UPDATE memories SET content='changed while model ran',normalized_hash=?1 WHERE id=1", [mc_store::compute_normalized_memory_hash("changed while model ran")])?; Ok(()) }).unwrap();
        }));
        let result = fixture.host(carrier).run(None).await.unwrap().unwrap();
        assert_eq!(result.verification.counts.verified, 0);
        assert_eq!(
            fixture.scalar("SELECT COUNT(*) FROM memories WHERE id=1 AND verified_at IS NOT NULL"),
            0
        );
        assert_eq!(
            fixture.scalar(
                "SELECT COUNT(*) FROM memory_decision_receipts WHERE decision_key LIKE '%:1'"
            ),
            0
        );
        assert_eq!(
            fixture.scalar("SELECT COUNT(*) FROM memory_embeddings WHERE memory_id=1"),
            1
        );
    }

    #[tokio::test]
    async fn dream_verify_second_effect_failure_rolls_back_entire_verification_batch() {
        let fixture = Fixture::new(TaskName::Verify);
        fixture.store.with_context_conn_for_test(|tx| tx.execute_batch("CREATE TRIGGER fail_embedding_delete BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=3 BEGIN SELECT RAISE(ABORT,'second embedding effect failed'); END;")).unwrap();
        let error = fixture.host(fixture.carrier()).run(None).await.unwrap_err();
        assert!(error.contains("second embedding effect failed"), "{error}");
        fixture.assert_no_effect();
    }

    #[tokio::test]
    async fn dream_verify_second_expiry_failure_rolls_back_history_undo_and_queue() {
        let fixture = Fixture::new(TaskName::Verify);
        fixture.store.with_context_conn_for_test(|tx| {
            tx.execute("UPDATE memories SET expires_at=10000 WHERE id IN (1,2)", [])?;
            tx.execute_batch("CREATE TRIGGER fail_embedding_delete BEFORE DELETE ON memory_embeddings WHEN OLD.memory_id=2 BEGIN SELECT RAISE(ABORT,'second archive effect failed'); END;")
        }).unwrap();
        let error = fixture.host(fixture.carrier()).run(None).await.unwrap_err();
        assert!(error.contains("second archive effect failed"), "{error}");
        fixture.assert_no_effect();
    }

    #[tokio::test]
    async fn dream_verify_expiry_restart_does_not_duplicate_history_or_undo() {
        let fixture = Fixture::new(TaskName::Verify);
        fixture
            .store
            .with_context_conn_for_test(|tx| {
                tx.execute(
                    "UPDATE memories SET expires_at=10000 WHERE project_path='project'",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        let mut carrier = fixture.carrier();
        carrier.answer.clear();
        let mut host = fixture.host(carrier);
        assert_eq!(host.run(None).await.unwrap().unwrap().expired, 3);
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
            closed: 0,
        };
        let mut host = VerifyHost::new(carrier, store.clone(), context);
        assert_eq!(host.run(None).await.unwrap().unwrap().expired, 0);
        for table in ["memory_history", "memory_journal"] {
            assert_eq!(
                store
                    .with_context_read(|db| db.query_row(
                        &format!("SELECT COUNT(*) FROM {table}"),
                        [],
                        |row| row.get::<_, i64>(0)
                    ))
                    .unwrap(),
                3
            );
        }
        assert_eq!(
            store
                .with_context_read(|db| db.query_row(
                    "SELECT COUNT(*) FROM memory_embeddings",
                    [],
                    |row| row.get::<_, i64>(0)
                ))
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn dream_verify_expired_task_lease_refuses_before_any_effect() {
        let mut fixture = Fixture::new(TaskName::Verify);
        Arc::get_mut(&mut fixture.context)
            .unwrap()
            .task_lease
            .expires_at_ms = 10_000;
        assert!(fixture.host(fixture.carrier()).run(None).await.is_err());
        fixture.assert_no_effect();
    }

    #[test]
    fn dream_verify_paths_reject_untracked_traversal_and_symlink_escape() {
        let fixture = Fixture::new(TaskName::Verify);
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
        let mut host = fixture.host(fixture.carrier());
        host.capture_paths().unwrap();
        assert_eq!(host.normalized_path("./lib.rs"), Some("lib.rs".into()));
        for path in ["untracked.rs", "../outside.rs", "escape.rs"] {
            assert_eq!(host.normalized_path(path), None);
        }
    }

    #[tokio::test]
    async fn dream_verify_restart_receipts_prevent_second_model_and_effect() {
        let fixture = Fixture::new(TaskName::Verify);
        let mut host = fixture.host(fixture.carrier());
        host.run(None).await.unwrap().unwrap();
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM memory_history"), 2);
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
            closed: 0,
        };
        let mut host = VerifyHost::new(carrier, store.clone(), context);
        assert_eq!(
            host.run(None).await.unwrap().unwrap().verification.in_scope,
            0
        );
        assert!(host.carrier.requests.is_empty());
        assert_eq!(
            store
                .with_context_read(|db| db.query_row(
                    "SELECT COUNT(*) FROM memory_history",
                    [],
                    |row| row.get::<_, i64>(0)
                ))
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .with_context_read(|db| db.query_row(
                    "SELECT COUNT(*) FROM memory_embeddings",
                    [],
                    |row| row.get::<_, i64>(0)
                ))
                .unwrap(),
            2
        );
    }
}
