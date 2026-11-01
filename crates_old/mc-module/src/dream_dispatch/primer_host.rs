//! Primer promotion and grounded answer refresh over captured dream inputs.

use std::{
    cmp::Ordering,
    sync::{
        atomic::{AtomicUsize, Ordering as MemoryOrdering},
        Arc,
    },
    time::Duration,
};

use mc_store::{
    dream_primer::{AnswerWrite, PrimerSnapshot, PromotionWrite, VectorWrite},
    dream_scheduler::schedules::TaskName,
    McStore,
};
use rusqlite::Transaction;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

use super::context::TaskContext;
use crate::{
    dream_runner::{
        self, Attempt, CarrierError, ChildRequest, Completion, DreamCarrier, DreamRequest,
        DreamRole,
    },
    dream_tasks::{
        classify::TaskError,
        primers::{self, Candidate, Primer},
    },
};

/// Embedding RPCs are optional. A candidate or active primer is pending when its
/// vector is absent or belongs to a different model than `embedding_model()`.
/// Unavailable RPCs leave those source rows pending for the next scan.
/// Messages must be the real child transcript, not synthesized from its answer.
#[allow(async_fn_in_trait)]
pub trait PrimerCarrier: DreamCarrier {
    fn embedding_model(&self) -> Option<&str> {
        None
    }
    async fn embed_questions(
        &mut self,
        _questions: &[String],
    ) -> Result<Vec<Vec<f32>>, CarrierError> {
        Ok(Vec::new())
    }
    fn messages(&self, child: &str) -> Value;
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RefreshResult {
    pub refreshed: usize,
    pub skipped: usize,
}

#[derive(Debug)]
pub enum Outcome {
    Promote(primers::PromotionResult),
    Refresh(RefreshResult),
    Inactive,
}

pub struct PrimerHost<C: PrimerCarrier> {
    carrier: C,
    store: Arc<McStore>,
    context: Arc<TaskContext>,
    attempts: Vec<Attempt>,
}

fn convert<T: DeserializeOwned>(value: impl Serialize) -> Result<T, TaskError> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|e| TaskError::Commit(e.to_string()))
}

/// JavaScript's relational/default string ordering compares UTF-16 code units.
/// UTF-8 ordering differs when an astral scalar precedes a high BMP scalar.
fn compare_keys(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

impl<C: PrimerCarrier> PrimerHost<C> {
    pub fn new(carrier: C, store: Arc<McStore>, context: Arc<TaskContext>) -> Self {
        Self {
            carrier,
            store,
            context,
            attempts: Vec::new(),
        }
    }
    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    /// Routing remains opt-in at the dispatcher; this host never rereads activation.
    pub async fn run(&mut self) -> Result<Outcome, TaskError> {
        if !matches!(
            self.context.task,
            TaskName::PromotePrimers | TaskName::RefreshPrimers
        ) {
            return Err(TaskError::Commit(
                "primer host received another task".into(),
            ));
        }
        if !self.context.config.activated {
            return Ok(Outcome::Inactive);
        }
        self.check_control()?;
        match self.context.task {
            TaskName::PromotePrimers => self.promote().await.map(Outcome::Promote),
            TaskName::RefreshPrimers => self.refresh().await.map(Outcome::Refresh),
            _ => unreachable!("task checked before loading inputs"),
        }
    }

    fn check_control(&self) -> Result<(), TaskError> {
        self.context.check_control().map_err(|e| match e {
            super::context::ControlError::BudgetExhausted => TaskError::Budget,
            _ => TaskError::LeaseLost,
        })
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
    fn snapshot(&self) -> Result<PrimerSnapshot, TaskError> {
        self.store
            .load_dream_primers(&self.context.scope.project.0)
            .map_err(|e| TaskError::Commit(e.to_string()))
    }

    async fn promote(&mut self) -> Result<primers::PromotionResult, TaskError> {
        let snapshot = self.snapshot()?;
        let mut candidates: Vec<Candidate> = convert(&snapshot.candidates)?;
        let mut active: Vec<Primer> = convert(&snapshot.primers)?;
        let now = self.context.now_ms();
        // Determine removals before requesting vectors: expired candidates that
        // are not protected by active primers must not incur an embedding RPC.
        let threshold = self
            .context
            .config
            .effective
            .pointer("/dreamer/tasks/promote-primers/promotion_threshold")
            .and_then(Value::as_u64)
            .unwrap_or(2) as usize;
        let preliminary = primers::plan_promotion(
            &snapshot.project,
            &self.context.domain_lease.key,
            now,
            threshold,
            &candidates,
            &active,
            &[],
            compare_keys,
        );
        candidates
            .retain(|candidate| candidate.source_message_time >= now - primers::CANDIDATE_TTL_MS);
        let mut updates = Vec::new();
        let mut primer_updates = Vec::new();
        if let Some(model) = self.carrier.embedding_model().map(str::to_owned) {
            let (candidate_ids, primer_ids) = snapshot.pending_vectors(&model);
            let pending_candidates = candidates
                .iter()
                .filter(|c| {
                    candidate_ids.contains(&c.id)
                        && !preliminary.pruned_candidate_ids.contains(&c.id)
                })
                .collect::<Vec<_>>();
            let pending_primers = active
                .iter()
                .filter(|p| primer_ids.contains(&p.id))
                .collect::<Vec<_>>();
            let questions = pending_candidates
                .iter()
                .map(|c| c.question.clone())
                .chain(pending_primers.iter().map(|p| p.question.clone()))
                .collect::<Vec<_>>();
            if !questions.is_empty() {
                let vectors = self
                    .carrier
                    .embed_questions(&questions)
                    .await
                    .unwrap_or_default();
                self.check_control()?;
                {
                    for (index, vector) in vectors.into_iter().take(questions.len()).enumerate() {
                        if vector.is_empty() || vector.iter().any(|v| !v.is_finite()) {
                            continue;
                        }
                        let write = VectorWrite {
                            candidate_id: if index < pending_candidates.len() {
                                pending_candidates[index].id
                            } else {
                                pending_primers[index - pending_candidates.len()].id
                            },
                            vector,
                            model_id: model.clone(),
                        };
                        if index < pending_candidates.len() {
                            updates.push(write);
                        } else {
                            primer_updates.push(write);
                        }
                    }
                }
            }
            // Wrong-model vectors cannot participate in clustering with a fresh
            // model. An unavailable embedding service retains text-only matching.
            for candidate in &mut candidates {
                if candidate_ids.contains(&candidate.id) {
                    candidate.question_embedding = None;
                    candidate.question_embedding_model_id = None;
                }
            }
            for primer in &mut active {
                if primer_ids.contains(&primer.id) {
                    primer.question_embedding = None;
                    primer.question_embedding_model_id = None;
                }
                if let Some(update) = primer_updates.iter().find(|u| u.candidate_id == primer.id) {
                    primer.question_embedding = Some(update.vector.clone());
                    primer.question_embedding_model_id = Some(update.model_id.clone());
                }
            }
        }
        let embeddings = convert::<Vec<primers::EmbeddingUpdate>>(&updates)?;
        let mut batch = primers::plan_promotion(
            &snapshot.project,
            &self.context.domain_lease.key,
            now,
            threshold,
            &candidates,
            &active,
            &embeddings,
            compare_keys,
        );
        batch.pruned_candidate_ids = preliminary.pruned_candidate_ids;
        batch.result.pruned = batch.pruned_candidate_ids.len();
        let write: PromotionWrite = convert(&batch)?;
        self.store
            .commit_dream_primer_promotion(&snapshot, &write, &primer_updates, |tx| {
                self.check_commit_fence(tx)
            })
            .map_err(|e| TaskError::Commit(e.to_string()))?;
        Ok(batch.result)
    }

    async fn refresh(&mut self) -> Result<RefreshResult, TaskError> {
        let initial = self.snapshot()?;
        let active: Vec<Primer> = convert(initial.primers)?;
        let ids = primers::refresh_queue(&self.context.scope.project.0, &active)
            .iter()
            .map(|p| p.id)
            .collect::<Vec<_>>();
        let mut result = RefreshResult::default();
        for (index, id) in ids.iter().enumerate() {
            self.check_control()?;
            let remaining = self
                .context
                .deadline_ms
                .saturating_sub(self.context.now_ms());
            if remaining <= 0 {
                break;
            }
            let snapshot = self.snapshot()?;
            let candidates: Vec<Candidate> = convert(&snapshot.candidates)?;
            let active: Vec<Primer> = convert(&snapshot.primers)?;
            let Some(primer) = active.iter().find(|p| p.id == *id) else {
                continue;
            };
            let compartments: Vec<primers::SeedCompartment> = convert(&snapshot.compartments)?;
            let seed = primers::build_seed(primer, &candidates, None, &compartments, |text| {
                text.len().div_ceil(4)
            });
            let prompt = investigation_prompt(primer, &seed);
            let context = Arc::clone(&self.context);
            let calls = AtomicUsize::new(0);
            let mut carrier = GroundedCarrier {
                inner: &mut self.carrier,
                calls: &calls,
            };
            let run = dream_runner::run_dream_task(
                context.config.activated,
                &context.config.route,
                &context.config.effective,
                &DreamRequest {
                    task: context.task.as_str(),
                    role: DreamRole::PrimerInvestigator,
                    harness: &context.config.harness,
                    parent_session_id: &context.scope.session.0,
                    directory: context.directory(),
                    system: SYSTEM,
                    prompt: &prompt,
                    timeout: Duration::from_millis(
                        (remaining as u64 / (ids.len() - index) as u64).max(1),
                    ),
                    token_budget: context.task.default_budget(),
                    allow_empty: false,
                },
                &mut carrier,
                |completion| {
                    primers::plan_answer(
                        primer,
                        &context.domain_lease.key,
                        &completion.text,
                        calls.load(MemoryOrdering::Relaxed),
                        context.now_ms(),
                    )
                },
            )
            .await;
            self.attempts.extend(run.attempts);
            self.check_control()?;
            let answer = run.result.map_err(TaskError::Runner)?;
            if let Some(answer) = answer {
                let answer: AnswerWrite = convert(answer)?;
                self.store
                    .commit_dream_primer_answer(&snapshot, &answer, |tx| {
                        self.check_commit_fence(tx)
                    })
                    .map_err(|e| TaskError::Commit(e.to_string()))?;
                result.refreshed += 1;
            } else {
                result.skipped += 1;
            }
        }
        Ok(result)
    }
}

struct GroundedCarrier<'a, C> {
    inner: &'a mut C,
    calls: &'a AtomicUsize,
}
impl<C: PrimerCarrier> DreamCarrier for GroundedCarrier<'_, C> {
    async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
        self.calls.store(0, MemoryOrdering::Relaxed);
        self.inner.open(request).await
    }
    async fn complete(
        &mut self,
        child: &str,
        request: &ChildRequest,
    ) -> Result<Completion, CarrierError> {
        let result = self.inner.complete(child, request).await;
        self.calls.store(
            self.inner
                .messages(child)
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| m["parts"].as_array())
                .flatten()
                .filter(|p| {
                    p["type"] == "tool" && p["tool"].as_str().is_some_and(|s| !s.is_empty())
                })
                .count(),
            MemoryOrdering::Relaxed,
        );
        result
    }
    async fn close(&mut self, child: &str, settled: bool) -> Result<(), CarrierError> {
        self.inner.close(child, settled).await
    }
}

const SYSTEM: &str = "You are a read-only code investigator for the magic-context system. You run during a scheduled dream window to answer a single standing question about THIS codebase by reading its current source.\n\n## Tools (read-only)\n`read`, `grep`, `glob`, `aft_outline`, `aft_zoom`, `aft_search`. You have no write, edit, bash, or memory tools — you investigate and report, you change nothing.\n\n## Rules\n- **Ground every claim in code you actually opened this run.** Open the files the question points at and verify against them. A paraphrase that reads no files is not an answer.\n- **Answer directly and concretely** — name paths, symbols, and mechanisms, in present tense.";

fn investigation_prompt(primer: &Primer, seed: &primers::Seed) -> String {
    format!("## Task: Refresh a Magic Context Primer by investigating the current code\n\nYou maintain a concise, durable answer to a standing question about how THIS\nproject currently works. Your job is to GROUND the answer in today's source.\n\n### Question\n{}\n\n### Current Answer\n{}\n\n### Orientation (compartment summary — raw episode unavailable)\n{}\n\n### Surrounding context\n{}\n\n### Instructions\n- Use your tools (read / grep / glob / aft_outline / aft_zoom / aft_search) to\n  investigate the CURRENT source. Open the files the orientation points at, and\n  follow the code from there.\n- Ground every claim in code you actually read THIS run. Where the orientation's\n  old conclusions conflict with current source, current source wins.\n- Prefer stable architecture / invariants over transient task status.\n- Keep the answer concise (~3-8 bullets or short paragraphs).\n- If you cannot ground an answer in current code, return the current answer\n  unchanged if it is non-empty; otherwise return an empty string.\n\nReturn valid JSON only, no markdown fencing:\n{{ \"answer\": \"...\" }}", primer.question, if primer.answer.trim().is_empty() { "(empty)" } else { primer.answer.trim() }, if seed.orientation.is_empty() { "(none)" } else { &seed.orientation }, if seed.pre_post.is_empty() { "(none)" } else { &seed.pre_post })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dream_dispatch::context::{
        Cancellation, CapturedConfig, Clock, ControlError, TaskControl,
    };
    use mc_store::{
        dream_scheduler::budget::BudgetAction,
        parity_schema_manifest::{
            DreamLease, Generation, InvocationId, ProjectId, SessionId, StoreScope,
        },
        SqliteContextDomain,
    };
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicBool, AtomicI64, Ordering as AtomicOrdering},
    };

    const NOW: i64 = 20 * primers::DAY_MS;
    struct Time(AtomicI64);
    impl Clock for Time {
        fn now_ms(&self) -> i64 {
            self.0.load(AtomicOrdering::SeqCst)
        }
    }
    #[derive(Default)]
    struct Control(AtomicBool);
    impl TaskControl for Control {
        fn check_control(&self) -> Result<(), ControlError> {
            if self.0.load(AtomicOrdering::SeqCst) {
                Err(ControlError::LeaseLost)
            } else {
                Ok(())
            }
        }
        fn charge_usage(
            &self,
            _: &str,
            _: &dream_runner::Usage,
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
        tools: bool,
        /// Whether an embedding model is available.
        embed: bool,
    }
    impl FakeCarrier {
        fn callback(&mut self) {
            if let Some(callback) = self.during_model.take() {
                callback();
            }
        }
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
            self.callback();
            assert!(
                !self.answer.is_empty(),
                "durable refresh marker must suppress model replay"
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
    impl PrimerCarrier for FakeCarrier {
        fn embedding_model(&self) -> Option<&str> {
            self.embed.then_some("active")
        }
        async fn embed_questions(
            &mut self,
            questions: &[String],
        ) -> Result<Vec<Vec<f32>>, CarrierError> {
            self.callback();
            Ok(questions
                .iter()
                .map(|q| {
                    if q.starts_with("Second") {
                        vec![0.0, 1.0]
                    } else {
                        vec![1.0, 0.0]
                    }
                })
                .collect())
        }
        fn messages(&self, _: &str) -> Value {
            if self.tools {
                json!([{"info":{"role":"assistant"},"parts":[{"type":"tool","tool":"read","state":{"status":"completed","input":{"filePath":"lib.rs"},"output":"current implementation"}}]}])
            } else {
                json!([])
            }
        }
    }
    struct Fixture {
        dir: tempfile::TempDir,
        path: PathBuf,
        store: Arc<McStore>,
        context: Arc<TaskContext>,
        control: Arc<Control>,
        time: Arc<Time>,
    }
    impl Fixture {
        fn new(task: TaskName) -> Self {
            let root = std::env::temp_dir().join("magic-context/i5-5d");
            std::fs::create_dir_all(&root).unwrap();
            let dir = tempfile::tempdir_in(root).unwrap();
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let cortexkit_store_types::StorageBackend::Sqlite { path } = &descriptor.backend else {
                panic!("sqlite required")
            };
            let path = PathBuf::from(path).with_file_name("context.db");
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let control = Arc::new(Control::default());
            let time = Arc::new(Time(AtomicI64::new(NOW)));
            let scope = StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("session".into()),
                generation: Generation(1),
            };
            let domain_lease = store
                .acquire_dream_domain(&task.lease_key("project"), "holder", NOW)
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
                    directory: dir.path().to_path_buf(),
                }),
                domain_lease,
                task_lease: DreamLease {
                    scope,
                    invocation: InvocationId("invoke".into()),
                    token: "token".into(),
                    expires_at_ms: NOW + 10_000_000,
                },
                cancellation: Cancellation::default(),
                clock: time.clone(),
                deadline_ms: NOW + 10_000_000,
                control: control.clone(),
            });
            let fixture = Self {
                dir,
                path,
                store,
                context,
                control,
                time,
            };
            fixture.sql(|tx| {
                for id in 1..=7 {
                    let project=if id==7 {"foreign"} else {"project"};
                    let question=if id>3 && id<7 {"Second subsystem"} else {"How does routing work"};
                    let day=12+((id-1)%3)*4;
                    tx.execute("INSERT INTO primer_candidates(id,project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES (?1,?2,'opencode',?3,?4,?5,1,3,?6,?6,?7,1)",params![id,project,format!("source-{id}"),question,question.to_lowercase(),format!("m{id}"),day*primers::DAY_MS])?;
                }
                if task==TaskName::RefreshPrimers {
                    tx.execute("INSERT INTO primers(id,project_path,question,answer,total_support,last_observed_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at) VALUES (1,'project','How does routing work?','',3,?1,'[1,2,3]',?2,1,1)",params![NOW-1,r#"[{"candidate_id":1,"project_path":"project","harness":"opencode","session_id":"source-1","source_compartment_start":1,"source_compartment_end":3,"source_start_message_id":"m1","source_end_message_id":"m1"}]"#])?;
                }
                tx.execute("INSERT INTO session_meta(session_id,served_prefix) VALUES ('session','frozen prefix'),('other-session','other prefix')", [])?;
                tx.execute("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES ('session','cached_m0_bytes',?1),('other-session','cached_m0_bytes',?2)", params![b"frozen bytes",b"other bytes"])?;
                tx.execute("INSERT INTO project_state(project_path,project_memory_epoch) VALUES ('project',7),('foreign',9)", [])?;
                Ok(())
            });
            fixture
        }
        fn sql(&self, f: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<()>) {
            self.store.with_context_conn_for_test(f).unwrap();
        }
        fn scalar(&self, sql: &str) -> i64 {
            self.store
                .with_context_read(|conn| conn.query_row(sql, [], |r| r.get(0)))
                .unwrap()
        }
        fn carrier(&self) -> FakeCarrier {
            FakeCarrier {
                answer: json!({"answer":"Routing is dispatched by lib.rs."}).to_string(),
                during_model: None,
                requests: Vec::new(),
                tools: true,
                embed: true,
            }
        }
        fn host(&self) -> PrimerHost<FakeCarrier> {
            PrimerHost::new(self.carrier(), self.store.clone(), self.context.clone())
        }
        fn assert_no_effect(&self) {
            assert_eq!(
                self.scalar(
                    "SELECT COUNT(*) FROM primer_candidates WHERE question_embedding IS NOT NULL"
                ),
                0
            );
            assert_eq!(self.scalar("SELECT COUNT(*) FROM primers WHERE answer_refreshed_at IS NOT NULL OR answer<>''"),0);
            assert_eq!(
                self.scalar("SELECT COUNT(*) FROM primers"),
                i64::from(self.context.task == TaskName::RefreshPrimers)
            );
        }
        fn reopen(self) -> Self {
            let Self {
                dir,
                path,
                store,
                context,
                control,
                time,
            } = self;
            drop(store);
            let store = Arc::new(
                McStore::open_for_test(&crate::dev_descriptor_at(dir.path().to_str().unwrap()))
                    .unwrap(),
            );
            Self {
                dir,
                path,
                store,
                context,
                control,
                time,
            }
        }
    }

    #[tokio::test]
    async fn dream_primer_promote_and_refresh_persist_support_provenance_and_vectors() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        let result = fixture.host().run().await.unwrap();
        assert!(matches!(
            result,
            Outcome::Promote(primers::PromotionResult { promoted: 2, .. })
        ));
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primers WHERE total_support=3 AND json_array_length(source_candidate_ids)=3 AND json_array_length(source_candidate_provenance)=3 AND question_embedding_model_id='active' AND answer='' AND answer_refreshed_at IS NULL"),2);
        assert_eq!(
            fixture.scalar(
                "SELECT COUNT(*) FROM primer_candidates WHERE question_embedding_model_id='active'"
            ),
            6
        );
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primer_candidates WHERE project_path='foreign' AND question_embedding IS NULL"),1);
        let fixture = Fixture::new(TaskName::RefreshPrimers);
        let provenance = fixture.store.load_dream_primers("project").unwrap().primers[0]
            ["sourceProvenance"]
            .clone();
        // The fixture stores source_candidate_provenance in the TypeScript
        // snake-case shape; the snapshot reads it back as camel-case entries.
        assert_eq!(provenance[0]["candidateId"], 1, "{provenance}");
        let mut host = fixture.host();
        assert!(matches!(
            host.run().await.unwrap(),
            Outcome::Refresh(RefreshResult {
                refreshed: 1,
                skipped: 0
            })
        ));
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primers WHERE answer='Routing is dispatched by lib.rs.' AND answer_refreshed_at IS NOT NULL"),1);
        assert_eq!(
            fixture.store.load_dream_primers("project").unwrap().primers[0]["sourceProvenance"],
            provenance
        );
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM session_meta WHERE (session_id='session' AND served_prefix='frozen prefix' AND (SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes')=X'66726F7A656E206279746573') OR (session_id='other-session' AND served_prefix='other prefix' AND (SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes')=X'6F74686572206279746573')"),2);
        assert_eq!(
            fixture.scalar("SELECT SUM(project_memory_epoch) FROM project_state"),
            16
        );
        let request = &host.carrier.requests[0];
        assert_eq!(request.parent_session_id, "session");
        assert_eq!(request.directory, fixture.dir.path());
        assert_eq!(request.agent, "dreamer-primer-investigator");
        assert!(request.prompt.contains("How does routing work?"));
        assert!(request.allowed_tools.contains(&"read"));
        assert_eq!(host.attempts().len(), 1);
    }

    #[tokio::test]
    async fn dream_primer_stolen_domain_has_zero_writes() {
        for task in [TaskName::PromotePrimers, TaskName::RefreshPrimers] {
            let fixture = Fixture::new(task);
            let mut host = fixture.host();
            let store = fixture.store.clone();
            let lease = fixture.context.domain_lease.clone();
            host.carrier.during_model = Some(Box::new(move || {
                assert!(store.release_dream_domain(&lease).unwrap());
                store
                    .acquire_dream_domain(&lease.key, "thief", NOW + 1)
                    .unwrap()
                    .unwrap();
            }));
            assert!(host.run().await.is_err());
            fixture.assert_no_effect();
        }
    }
    #[tokio::test]
    async fn dream_primer_expired_domain_has_zero_writes() {
        for task in [TaskName::PromotePrimers, TaskName::RefreshPrimers] {
            let fixture = Fixture::new(task);
            let mut host = fixture.host();
            let time = fixture.time.clone();
            let expiry = fixture.context.domain_lease.expires_at_ms;
            host.carrier.during_model = Some(Box::new(move || {
                time.0.store(expiry, AtomicOrdering::SeqCst)
            }));
            assert!(host.run().await.is_err());
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
                if self.armed.load(AtomicOrdering::SeqCst) {
                    self.control.0.store(true, AtomicOrdering::SeqCst);
                }
                write(tx)
            })
        }
    }
    #[tokio::test]
    async fn dream_primer_task_loss_inside_writer_has_zero_writes() {
        for task in [TaskName::PromotePrimers, TaskName::RefreshPrimers] {
            let fixture = Fixture::new(task);
            let armed = Arc::new(AtomicBool::new(false));
            fixture
                .store
                .install_context_domain(Arc::new(LoseTaskOnWrite {
                    inner: SqliteContextDomain::open(&fixture.path).unwrap(),
                    armed: armed.clone(),
                    control: fixture.control.clone(),
                }));
            let mut host = fixture.host();
            host.carrier.during_model =
                Some(Box::new(move || armed.store(true, AtomicOrdering::SeqCst)));
            assert!(host.run().await.is_err());
            fixture.assert_no_effect();
        }
    }
    #[tokio::test]
    async fn dream_primer_input_hash_drift_refuses_late_vectors_and_answers() {
        for task in [TaskName::PromotePrimers, TaskName::RefreshPrimers] {
            let fixture = Fixture::new(task);
            let mut host = fixture.host();
            let store = fixture.store.clone();
            host.carrier.during_model = Some(Box::new(move || {
                store.with_context_conn_for_test(|tx| { tx.execute("UPDATE primer_candidates SET question='Changed while embedding',normalized_question='changed' WHERE id=1",[])?; Ok(()) }).unwrap();
            }));
            assert!(host.run().await.is_err());
            fixture.assert_no_effect();
        }
    }
    #[tokio::test]
    async fn dream_primer_removed_candidates_and_archived_primers_never_revive() {
        for archive in [false, true] {
            let fixture = Fixture::new(TaskName::PromotePrimers);
            fixture.sql(|tx| { tx.execute("INSERT INTO primers(project_path,question,created_at,updated_at) VALUES ('project','old question',1,1)",[])?; Ok(()) });
            let mut host = fixture.host();
            let store = fixture.store.clone();
            host.carrier.during_model = Some(Box::new(move || {
                store
                    .with_context_conn_for_test(|tx| {
                        if archive {
                            tx.execute("UPDATE primers SET status='archived'", [])?;
                        } else {
                            tx.execute("DELETE FROM primer_candidates WHERE id=1", [])?;
                        }
                        Ok(())
                    })
                    .unwrap();
            }));
            assert!(host.run().await.is_err());
            assert_eq!(
                fixture.scalar(
                    "SELECT COUNT(*) FROM primer_candidates WHERE question_embedding IS NOT NULL"
                ),
                0
            );
            assert_eq!(
                fixture.scalar("SELECT COUNT(*) FROM primers WHERE question_embedding IS NOT NULL"),
                0
            );
            if archive {
                assert_eq!(
                    fixture.scalar("SELECT COUNT(*) FROM primers WHERE status='archived'"),
                    1
                );
            } else {
                assert_eq!(
                    fixture.scalar("SELECT COUNT(*) FROM primer_candidates WHERE id=1"),
                    0
                );
            }
        }
    }
    #[tokio::test]
    async fn dream_primer_later_support_failure_rolls_back_entire_batch() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        fixture.sql(|tx|tx.execute_batch("CREATE TRIGGER fail_second_primer BEFORE INSERT ON primers WHEN new.question='Second subsystem?' BEGIN SELECT RAISE(ABORT,'second support failed'); END;"));
        assert!(fixture.host().run().await.is_err());
        fixture.assert_no_effect();
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primers_fts"), 0);
    }
    #[tokio::test]
    async fn dream_primer_restart_replay_has_no_second_effect() {
        let mut fixture = Fixture::new(TaskName::PromotePrimers);
        fixture.host().run().await.unwrap();
        let before = fixture
            .store
            .load_dream_primers("project")
            .unwrap()
            .input_hash;
        fixture = fixture.reopen();
        fixture.time.0.fetch_add(1, AtomicOrdering::SeqCst);
        fixture.host().run().await.unwrap();
        assert_eq!(
            fixture
                .store
                .load_dream_primers("project")
                .unwrap()
                .input_hash,
            before
        );
        let mut fixture = Fixture::new(TaskName::RefreshPrimers);
        fixture.host().run().await.unwrap();
        let before = fixture
            .store
            .load_dream_primers("project")
            .unwrap()
            .input_hash;
        fixture = fixture.reopen();
        let mut host = fixture.host();
        host.carrier.answer.clear();
        assert!(matches!(
            host.run().await.unwrap(),
            Outcome::Refresh(RefreshResult {
                refreshed: 0,
                skipped: 0
            })
        ));
        assert!(host.carrier.requests.is_empty());
        assert_eq!(
            fixture
                .store
                .load_dream_primers("project")
                .unwrap()
                .input_hash,
            before
        );
    }
    #[tokio::test]
    async fn dream_primer_refresh_without_real_tool_messages_is_skipped() {
        let fixture = Fixture::new(TaskName::RefreshPrimers);
        let mut host = fixture.host();
        host.carrier.tools = false;
        assert!(matches!(
            host.run().await.unwrap(),
            Outcome::Refresh(RefreshResult {
                refreshed: 0,
                skipped: 1
            })
        ));
        fixture.assert_no_effect();
    }
    #[tokio::test]
    async fn dream_primer_wrong_active_model_vectors_are_replaced_for_both_row_kinds() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        fixture.sql(|tx| {
            tx.execute("UPDATE primer_candidates SET question_embedding=?1,question_embedding_model_id='old' WHERE id=1", [vec![0_u8;8]])?;
            tx.execute("INSERT INTO primers(id,project_path,question,question_embedding,question_embedding_model_id,created_at,updated_at) VALUES (1,'project','How does routing work?',?1,'old',1,1)", [vec![0_u8;8]])?;
            Ok(())
        });
        fixture.host().run().await.unwrap();
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primer_candidates WHERE id=1 AND question_embedding_model_id='active' AND question_embedding=X'0000803F00000000'"),1);
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primers WHERE id=1 AND question_embedding_model_id='active' AND question_embedding=X'0000803F00000000'"),1);
    }

    #[tokio::test]
    async fn dream_primer_changed_primer_question_refuses_late_vector() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        fixture.sql(|tx| { tx.execute("INSERT INTO primers(project_path,question,created_at,updated_at) VALUES ('project','original',1,1)",[])?; Ok(()) });
        let mut host = fixture.host();
        let store = fixture.store.clone();
        host.carrier.during_model = Some(Box::new(move || {
            store
                .with_context_conn_for_test(|tx| {
                    tx.execute("UPDATE primers SET question='changed'", [])?;
                    Ok(())
                })
                .unwrap();
        }));
        assert!(host.run().await.is_err());
        assert_eq!(
            fixture.scalar("SELECT COUNT(*) FROM primers WHERE question_embedding IS NOT NULL"),
            0
        );
        assert_eq!(
            fixture.scalar(
                "SELECT COUNT(*) FROM primer_candidates WHERE question_embedding IS NOT NULL"
            ),
            0
        );
    }

    #[tokio::test]
    async fn dream_primer_task_lease_expiry_inside_writer_has_zero_writes() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        // The domain expires later than the task claim in this fixture. Advancing
        // only to the task expiry leaves live control and the domain valid.
        let Fixture {
            dir,
            path,
            store,
            mut context,
            control,
            time,
        } = fixture;
        Arc::get_mut(&mut context).unwrap().task_lease.expires_at_ms = NOW + 1;
        let fixture = Fixture {
            dir,
            path,
            store,
            context,
            control,
            time,
        };
        let mut host = fixture.host();
        let time = fixture.time.clone();
        host.carrier.during_model = Some(Box::new(move || {
            time.0.store(NOW + 1, AtomicOrdering::SeqCst)
        }));
        assert!(host.run().await.is_err());
        fixture.assert_no_effect();
    }

    #[tokio::test]
    async fn dream_primer_refresh_uses_scoped_compartment_seed_and_rechecks_it() {
        for drift in [false, true] {
            let fixture = Fixture::new(TaskName::RefreshPrimers);
            fixture.sql(|tx| {
                tx.execute("INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,p1,created_at,harness) VALUES ('source-3',1,1,3,'Routing map','body','Find router.rs',1,'opencode'),('source-3',0,0,0,'Before','context',NULL,1,'opencode'),('source-3',2,4,5,'After','context',NULL,1,'opencode'),('foreign',1,1,3,'Private','foreign secret',NULL,1,'opencode')",[])?;
                Ok(())
            });
            let mut host = fixture.host();
            if drift {
                let store = fixture.store.clone();
                host.carrier.during_model = Some(Box::new(move || {
                    store.with_context_conn_for_test(|tx| {tx.execute("UPDATE compartments SET p1='Changed source seed' WHERE session_id='source-3' AND sequence=1",[])?; Ok(())}).unwrap();
                }));
            }
            let result = host.run().await;
            let prompt = &host.carrier.requests[0].prompt;
            assert!(prompt.contains("Routing map: Find router.rs"));
            assert!(prompt.contains("(before) Before: context"));
            assert!(prompt.contains("(after) After: context"));
            assert!(!prompt.contains("foreign secret"));
            if drift {
                assert!(result.is_err());
                fixture.assert_no_effect();
            } else {
                assert!(result.is_ok());
            }
        }
    }

    #[tokio::test]
    async fn dream_primer_promotion_honors_captured_threshold_and_ttl_selection() {
        let fixture = Fixture::new(TaskName::PromotePrimers);
        let Fixture {
            dir,
            path,
            store,
            mut context,
            control,
            time,
        } = fixture;
        let config = Arc::get_mut(&mut Arc::get_mut(&mut context).unwrap().config).unwrap();
        config.effective =
            json!({"dreamer":{"tasks":{"promote-primers":{"promotion_threshold":4}}}});
        let fixture = Fixture {
            dir,
            path,
            store,
            context,
            control,
            time,
        };
        let result = fixture.host().run().await.unwrap();
        assert!(matches!(
            result,
            Outcome::Promote(primers::PromotionResult {
                promoted: 0,
                candidates: 6,
                ..
            })
        ));
        assert_eq!(fixture.scalar("SELECT COUNT(*) FROM primers"), 0);
        fixture.sql(|tx| {
            tx.execute("UPDATE primer_candidates SET source_message_time=?1 WHERE id=1",[NOW-100*primers::DAY_MS])?;
            tx.execute("INSERT INTO primers(project_path,question,source_candidate_ids,created_at,updated_at) VALUES ('project','How does routing work?','[1]',1,1)",[])?;
            Ok(())
        });
        let result = fixture.host().run().await.unwrap();
        assert!(matches!(
            result,
            Outcome::Promote(primers::PromotionResult {
                candidates: 5,
                pruned: 0,
                ..
            })
        ));
        assert_eq!(
            fixture.scalar("SELECT COUNT(*) FROM primer_candidates WHERE id=1"),
            1
        );
    }

    #[test]
    fn dream_primer_order_is_utf16_units_including_separators_case_accents_and_astral() {
        let mut keys = vec!["é", "a_", "\u{e000}", "a\u{1f}z", "A", "😀", "a/", "a", "É"];
        keys.sort_by(|a, b| compare_keys(a, b));
        // Expected order follows ECMAScript Array.prototype.sort on these
        // literal strings with no comparison function (UTF-16 code units).
        assert_eq!(
            keys,
            vec!["A", "a", "a\u{1f}z", "a/", "a_", "É", "é", "😀", "\u{e000}"]
        );
        assert_eq!(
            compare_keys("project\u{1f}😀\u{1f}1", "project\u{1f}\u{e000}\u{1f}1"),
            Ordering::Less
        );
    }

    fn rows(f: &Fixture, sql: &str) -> Value {
        f.store
            .with_context_read(|db| {
                let mut stmt = db.prepare(sql)?;
                let names: Vec<String> =
                    stmt.column_names().into_iter().map(str::to_owned).collect();
                let rows = stmt
                    .query_map([], |row| {
                        let mut object = serde_json::Map::new();
                        for (i, name) in names.iter().enumerate() {
                            let value = match row.get::<_, rusqlite::types::Value>(i)? {
                                rusqlite::types::Value::Null => Value::Null,
                                rusqlite::types::Value::Integer(v) => json!(v),
                                rusqlite::types::Value::Real(v) => json!(v),
                                rusqlite::types::Value::Text(v) => json!(v),
                                rusqlite::types::Value::Blob(v) => json!(v),
                            };
                            object.insert(name.clone(), value);
                        }
                        Ok(Value::Object(object))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(Value::Array(rows))
            })
            .unwrap()
    }

    fn assert_rows_match(f: &Fixture, step: &Value) {
        let name = step["step"].as_str().unwrap();
        assert_eq!(
            rows(f, "SELECT id,project_path,question,answer,status,total_support,last_observed_at,answer_refreshed_at,source_candidate_ids,source_candidate_provenance,question_embedding IS NULL AS no_embedding,created_at,updated_at FROM primers ORDER BY id"),
            step["primers"],
            "{name}"
        );
        let ids: Vec<i64> = rows(f, "SELECT id FROM primer_candidates ORDER BY id")
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect();
        assert_eq!(json!(ids), step["candidateIds"], "{name}");
    }

    /// testdata/dream_tasks/primers.json is what the TypeScript dreamer's
    /// promote-primers and refresh-primers (gen/gen-dream-primers-golden.ts)
    /// wrote, in sequence, for this fixture's candidates plus one past the TTL:
    /// promotion without an embedding provider, then a refresh whose
    /// investigator used no tools, then one that read code.
    #[tokio::test]
    async fn primer_rows_match_the_typescript_dreamer() {
        let golden: Value =
            serde_json::from_str(include_str!("../../testdata/dream_tasks/primers.json")).unwrap();
        assert_eq!(golden["now"], json!(NOW));
        let f = Fixture::new(TaskName::PromotePrimers);
        let expired = &golden["candidates"][7];
        assert_eq!(expired["id"], 8);
        f.sql(|tx| {
            tx.execute("INSERT INTO primer_candidates(id,project_path,harness,session_id,question,normalized_question,source_compartment_start,source_compartment_end,source_start_message_id,source_end_message_id,source_message_time,created_at) VALUES (8,?1,'opencode',?2,?3,?4,1,3,?5,?5,?6,1)",
                params![expired["project_path"].as_str(), expired["session_id"].as_str(), expired["question"].as_str(), expired["normalized_question"].as_str(), expired["message_id"].as_str(), expired["source_message_time"].as_i64()])?;
            Ok(())
        });
        // The golden's other candidates are this fixture's own.
        assert_eq!(
            rows(&f, "SELECT id,project_path,session_id,question,normalized_question,source_start_message_id AS message_id,source_message_time FROM primer_candidates ORDER BY id"),
            golden["candidates"]
        );
        let steps = golden["steps"].as_array().unwrap();
        let mut carrier = f.carrier();
        carrier.embed = false;
        let mut host = PrimerHost::new(carrier, f.store.clone(), f.context.clone());
        let Outcome::Promote(result) = host.run().await.unwrap() else {
            panic!("promotion expected")
        };
        assert_eq!(serde_json::to_value(&result).unwrap(), steps[0]["result"]);
        assert!(host.carrier.requests.is_empty());
        assert_rows_match(&f, &steps[0]);
        for step in &steps[1..] {
            let c = &f.context;
            let context = Arc::new(TaskContext {
                task: TaskName::RefreshPrimers,
                scope: c.scope.clone(),
                config: c.config.clone(),
                domain_lease: c.domain_lease.clone(),
                task_lease: c.task_lease.clone(),
                cancellation: c.cancellation.clone(),
                clock: c.clock.clone(),
                deadline_ms: c.deadline_ms,
                control: c.control.clone(),
            });
            let mut carrier = f.carrier();
            carrier.embed = false;
            carrier.tools = step["tools"].as_bool().unwrap();
            carrier.answer = step["answer"].as_str().unwrap().to_owned();
            let mut host = PrimerHost::new(carrier, f.store.clone(), context);
            let Outcome::Refresh(result) = host.run().await.unwrap() else {
                panic!("refresh expected")
            };
            assert_eq!(
                json!({"refreshed": result.refreshed, "skipped": result.skipped}),
                step["result"],
                "{}",
                step["step"]
            );
            assert_eq!(json!(host.carrier.requests.len()), step["modelCalls"]);
            assert_rows_match(&f, step);
        }
    }
}
