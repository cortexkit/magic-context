//! Background retrospective and global user-profile review over bounded session reads.

use std::{collections::HashSet, sync::Arc, time::Duration};

use mc_store::{dream_retrospective as durable, dream_scheduler::schedules::TaskName, McStore};
use rusqlite::{params, Transaction};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{adapters::EmbeddingQueue, context::TaskContext};
use crate::{
    dream_runner::{self, Attempt, DreamCarrier, DreamRequest, DreamRole, Failure},
    dream_tasks::retrospective::{self as plan, ScanOptions, SessionRead},
    memory_actions::{
        EmbeddingEffect, MemoryActionArgs, MemoryActionContext, MemoryActions,
        MemoryEmbeddingQueue, MemoryRole,
    },
};

/// Harness adapters supply bounded source reads, not rendered foreground prompts.
/// Each session contains rows from at most 80 new source messages and 12 prior
/// user lines, and must report truncation so the planner cannot advance past
/// unread source messages.
pub trait SessionReader {
    fn read_sessions(&self, project: &str, watermark_ms: i64) -> Result<Vec<SessionRead>, String>;
}

#[derive(Debug)]
pub enum HostError {
    Control(super::context::ControlError),
    Store(mc_store::McStoreError),
    Input(String),
    Model(Failure),
}

impl From<mc_store::McStoreError> for HostError {
    fn from(error: mc_store::McStoreError) -> Self {
        Self::Store(error)
    }
}

pub struct RetrospectiveHost<C: DreamCarrier> {
    carrier: C,
    store: Arc<McStore>,
    context: Arc<TaskContext>,
    attempts: Vec<Attempt>,
    authority: Option<mc_store::memory_levels::RunAuthority>,
}

impl<C: DreamCarrier> RetrospectiveHost<C> {
    pub fn new(carrier: C, store: Arc<McStore>, context: Arc<TaskContext>) -> Self {
        Self {
            carrier,
            store,
            context,
            attempts: Vec::new(),
            authority: None,
        }
    }

    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    pub fn with_authority(
        mut self,
        authority: Option<mc_store::memory_levels::RunAuthority>,
    ) -> Self {
        self.authority = authority;
        self
    }

    /// Reads the authoritative context checkpoint, then runs gate/deepen without
    /// holding a writer. The batch revalidates that checkpoint after model work.
    pub async fn run_retrospective(
        &mut self,
        reader: &impl SessionReader,
        options: &ScanOptions,
        collection_enabled: bool,
    ) -> Result<Option<plan::ApplyResult>, HostError> {
        if !self.context.config.activated {
            return Ok(None);
        }
        self.check_task(TaskName::Retrospective)?;
        let context = Arc::clone(&self.context);
        let project = &context.scope.project.0;
        let snapshot = self.store.load_dream_retrospective(project)?;
        let since = snapshot.state.watermark_ms;
        let mut scan = options.clone();
        // The caller's scan bounds are advisory; its watermark cannot override
        // the durable frontier used by both the provider and the commit fence.
        scan.watermark_ms = since;
        let sessions = reader
            .read_sessions(project, since)
            .map_err(HostError::Input)?;
        // One source message can yield a user row and several tool rows, which
        // share its ordinal; the bound is on source messages.
        let source_messages = |messages: &[plan::Message]| {
            messages
                .iter()
                .map(|m| m.ordinal)
                .collect::<HashSet<_>>()
                .len()
        };
        if sessions
            .iter()
            .any(|s| source_messages(&s.messages) > 80 || s.overlap.len() > 12)
        {
            return Err(HostError::Input(
                "session reader exceeded source bounds".into(),
            ));
        }
        let window = plan::scan_window(project, &sessions, &scan, |messages| {
            mc_tokenizer::estimate_tokens(&plan::gate_request(messages)).max(
                mc_tokenizer::estimate_tokens(&deepen_prompt(
                    project,
                    &plan::friction_window(messages, &(1..=messages.len()).collect::<Vec<_>>()),
                )),
            )
        });
        if window.max_scanned_ts <= since {
            return Ok(None);
        }
        let gate = if window.messages.is_empty() {
            "n".into()
        } else {
            self.model(
                DreamRole::Reviewer,
                "",
                &plan::gate_request(&window.messages),
                |c| Ok(c.text.clone()),
            )
            .await?
        };
        let verdict = plan::parse_gate(&gate);
        let flagged: Vec<_> = window
            .messages
            .iter()
            .enumerate()
            .filter(|(i, m)| {
                verdict.ordinals.contains(&(i + 1)) && m.role == "user" && !m.text.trim().is_empty()
            })
            .map(|(_, m)| m)
            .collect();
        let deepen = if verdict.hit
            && flagged.iter().any(|m| m.ts > since)
            && !snapshot
                .processed_windows
                .contains(&plan::window_key(&flagged))
        {
            self.model(
                DreamRole::Retrospective,
                RETROSPECTIVE_SYSTEM,
                &deepen_prompt(
                    project,
                    &plan::friction_window(&window.messages, &verdict.ordinals),
                ),
                |c| Ok(c.text.clone()),
            )
            .await?
        } else {
            String::new()
        };
        let existing = self
            .store
            .load_dream_metadata(project)?
            .into_iter()
            .map(|m| (m.memory.category, m.memory.normalized_hash))
            .collect::<HashSet<_>>();
        let batch = plan::plan_retrospective(
            project,
            &context.domain_lease.key,
            context.now_ms(),
            since,
            window.max_scanned_ts,
            &window.messages,
            &gate,
            &deepen,
            collection_enabled,
            &snapshot.processed_windows,
            &existing,
        );
        let current_state: Value = snapshot
            .state
            .task_state_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(Value::Null);
        let task_state = plan::completed_task_state(&current_state, since).map(|v| v.to_string());
        let observations: Vec<_> = batch
            .observations
            .iter()
            .map(|o| durable::Observation {
                content: o.content.clone(),
                session_id: o.session_id.clone(),
            })
            .collect();
        let commit = durable::RetrospectiveCommit {
            project,
            expected: &snapshot.state,
            watermark_ms: batch.retrospective_watermark_ms,
            window_key: batch.processed_window_key.as_deref(),
            task_state_json: task_state.as_deref(),
            now_ms: batch.write_time_ms,
            observations: &observations,
        };
        let applied = self.store.commit_dream_retrospective(
            &commit,
            |tx| self.check_commit_fence(tx),
            |tx| {
                let mut actions = MemoryActions::with_memory_writer(
                    self.store.run_memory_writer(self.authority.clone()),
                );
                for (index, row) in batch.memory_writes.iter().enumerate() {
                    let key = format!(
                        "dream:retrospective:{project}:{}:{index}",
                        batch.processed_window_key.as_deref().unwrap_or("empty")
                    );
                    let ctx = MemoryActionContext {
                        project_path: project,
                        session_id: &row.source_session_id,
                        harness: &context.config.harness,
                        role: MemoryRole::Dreamer,
                        workspace_members: &[],
                        shared_categories: &[],
                        curate_category: None,
                        memory_enabled: true,
                        now_ms: batch.write_time_ms,
                        decision_key: &key,
                    };
                    actions.execute_tx(
                        tx,
                        self,
                        &ctx,
                        &MemoryActionArgs {
                            action: Some("write".into()),
                            category: Some(row.category.clone()),
                            content: Some(row.content.clone()),
                            ..MemoryActionArgs::default()
                        },
                    )?;
                    let receipt: String = tx.query_row(
                        "SELECT receipt_json FROM memory_decision_receipts WHERE decision_key=?1",
                        [&key],
                        |r| r.get(0),
                    )?;
                    let receipt: Value = serde_json::from_str(&receipt)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;
                    if receipt["state"] != "applied" {
                        return Err(rusqlite::Error::InvalidQuery);
                    }
                    tx.execute(
                        "UPDATE memories SET metadata_json=?2 WHERE id=?1",
                        params![
                            receipt["memoryId"]
                                .as_i64()
                                .ok_or(rusqlite::Error::InvalidQuery)?,
                            row.metadata_json
                        ],
                    )?;
                }
                Ok(())
            },
        )?;
        Ok(applied.then_some(batch.result))
    }

    pub async fn run_user_review(
        &mut self,
        threshold: usize,
    ) -> Result<Option<plan::ReviewResult>, HostError> {
        if !self.context.config.activated {
            return Ok(None);
        }
        self.check_task(TaskName::ReviewUserMemories)?;
        let now = self.context.now_ms();
        let mut snapshot = self.store.load_dream_user_review()?;
        let candidates = |rows: &[durable::UserCandidate]| {
            rows.iter()
                .map(|c| plan::UserCandidate {
                    id: c.id,
                    content: c.content.clone(),
                    session_id: c.session_id.clone(),
                    created_at: c.created_at,
                    source_compartment_start: c.source_compartment_start,
                    source_compartment_end: c.source_compartment_end,
                })
                .collect::<Vec<_>>()
        };
        let preparation = plan::prepare_user_review(
            &self.context.domain_lease.key,
            now,
            threshold,
            &candidates(&snapshot.candidates),
        );
        if !preparation.pruned_candidate_ids.is_empty() {
            self.store.prune_dream_user_candidates(
                &snapshot.candidates,
                now - 30 * crate::dream_tasks::primers::DAY_MS,
                |tx| self.check_commit_fence(tx),
            )?;
            snapshot = self.store.load_dream_user_review()?;
        }
        if snapshot.candidates.is_empty() || snapshot.candidates.len() < threshold {
            return Ok(None);
        }
        let rows = candidates(&snapshot.candidates);
        let lease = self.context.domain_lease.key.clone();
        let batch = self
            .model(
                DreamRole::Reviewer,
                review_system().map_err(|error| HostError::Model(Failure::Validation(error)))?,
                &review_prompt(&snapshot, threshold)
                    .map_err(|error| HostError::Model(Failure::Validation(error)))?,
                |c| plan::plan_user_review(&lease, now, threshold, &rows, &c.text),
            )
            .await?;
        let key = format!(
            "dream:user-review:{:x}",
            Sha256::digest(
                serde_json::to_vec(&snapshot.candidates)
                    .map_err(|e| HostError::Input(e.to_string()))?
            )
        );
        let promotions: Vec<_> = batch
            .promotions
            .iter()
            .map(|p| durable::UserPromotion {
                content: p.content.clone(),
                candidate_ids: p.candidate_ids.clone(),
            })
            .collect();
        let updates: Vec<_> = batch
            .updates
            .iter()
            .map(|u| (u.memory_id, u.content.clone()))
            .collect();
        let applied = self.store.commit_dream_user_review(
            &durable::ReviewCommit {
                expected: &snapshot,
                decision_key: &key,
                now_ms: batch.write_time_ms,
                promotions: &promotions,
                updates: &updates,
                dismissals: &batch.dismissals,
                consume_candidate_ids: &batch.consume_candidate_ids,
            },
            |tx| self.check_commit_fence(tx),
        )?;
        Ok(applied.then_some(batch.result))
    }

    fn check_task(&self, task: TaskName) -> Result<(), HostError> {
        if self.context.task != task {
            return Err(HostError::Input(
                "retrospective host received another task".into(),
            ));
        }
        self.context.check_control().map_err(HostError::Control)
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

    fn enqueue(&self, tx: &Transaction<'_>, effect: &EmbeddingEffect) -> rusqlite::Result<()> {
        EmbeddingQueue.enqueue_tx(tx, effect)
    }

    async fn model<T>(
        &mut self,
        role: DreamRole,
        system: &str,
        prompt: &str,
        validate: impl FnMut(&dream_runner::Completion) -> Result<T, String>,
    ) -> Result<T, HostError> {
        let context = Arc::clone(&self.context);
        context.check_control().map_err(HostError::Control)?;
        let remaining = context.deadline_ms.saturating_sub(context.now_ms()).max(0) as u64;
        let request = DreamRequest {
            task: context.task.as_str(),
            role,
            harness: &context.config.harness,
            parent_session_id: &context.scope.session.0,
            directory: context.directory(),
            system,
            prompt,
            timeout: Duration::from_millis(remaining),
            token_budget: context.task.default_budget(),
            allow_empty: false,
        };
        let report = dream_runner::run_dream_task(
            context.config.activated,
            &context.config.route,
            &context.config.effective,
            &request,
            &mut self.carrier,
            validate,
        )
        .await;
        self.attempts.extend(report.attempts);
        report.result.map_err(HostError::Model)
    }
}

impl<C: DreamCarrier> MemoryEmbeddingQueue for RetrospectiveHost<C> {
    fn enqueue_tx(&self, tx: &Transaction<'_>, effect: &EmbeddingEffect) -> rusqlite::Result<()> {
        self.enqueue(tx, effect)
    }
}

const RETROSPECTIVE_SYSTEM: &str = "You are a retrospective learning agent for Magic Context.\n\nYou learn only from recurring user-friction moments where the user had to correct, re-explain, or recover from the assistant's repeated behavior. You receive a pre-rendered friction window from the host and may use ctx_search to look for corroborating prior patterns.\n\nRules:\n1. Pattern, not one-off: extract only recurring behavior that is likely to happen again. Zero learnings is fine.\n2. Distill, do not transcribe: never quote the user, never include dates, and never preserve session-local anger.\n3. Root cause + correction: the learning must tell a future agent what to do differently.\n4. Privacy by host-apply: do not call memory-writing tools. Emit only the XML schema requested by the prompt.";

fn deepen_prompt(project: &str, window: &str) -> String {
    format!(
        r#"## Task: Retrospective Learning

**Project:** {project}

The host detected possible user friction in the pre-rendered window below. Use it plus ctx_search (if helpful) to decide whether there is a recurring root cause and recurring assistant behavior worth remembering.

### Friction window
{window}

### Extraction rules
- Extract only durable, recurring learnings. A single annoyed/corrective message is noise.
- Write actionable present-tense corrections for future agents.
- Do NOT quote the user, include dates, or preserve anger/frustration wording.
- Write in plain prose with NO quotation marks at all. A learning containing any quotation marks is rejected.
- Use route="memory" for project-specific agent behavior/rules, with category one of PROJECT_RULES, ARCHITECTURE, CONSTRAINTS, CONFIG_VALUES, NAMING.
- Use route="observation" only for recurring user workflow/preferences that belong in the global user profile.
- Zero learnings is acceptable and should be represented by an empty learnings block.

Return only XML in this exact shape:
<learnings>
  <learning route="memory" category="PROJECT_RULES">one durable actionable correction</learning>
  <learning route="observation">one recurring user preference</learning>
</learnings>"#
    )
}

fn review_system() -> Result<&'static str, String> {
    crate::persona_host::dream::system(crate::persona_host::dream::Kind::ReviewUser)
        .map_err(|error| format!("mc_persona_invalid: {error}"))
}

fn review_prompt(snapshot: &durable::ReviewSnapshot, threshold: usize) -> Result<String, String> {
    let candidates = snapshot
        .candidates
        .iter()
        .map(|c| {
            format!(
                "- Candidate #{} [session {}]: {:?}",
                c.id,
                c.session_id.chars().take(12).collect::<String>(),
                c.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let profiles = snapshot
        .profiles
        .iter()
        .filter(|p| p.status == "active")
        .map(|p| format!("- Memory #{}: {:?}", p.id, p.content))
        .collect::<Vec<_>>()
        .join("\n");
    crate::persona_host::dream::task(
        crate::persona_host::dream::Kind::ReviewUser,
        &crate::persona_host::dream::Input {
            profiles: &profiles,
            candidates: &candidates,
            threshold,
            ..Default::default()
        },
    )
    .map_err(|error| format!("mc_persona_invalid: {error}"))
}

#[cfg(test)]
#[path = "../persona_host/dream/builder_oracle.rs"]
mod builder_oracle;

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
    use mc_store::{dream_scheduler::budget::BudgetAction, ContextDomain, SqliteContextDomain};
    use rusqlite::Connection;
    use serde_json::json;
    use std::{
        collections::VecDeque,
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

    struct FixtureReader;
    impl SessionReader for FixtureReader {
        fn read_sessions(&self, _: &str, since: i64) -> Result<Vec<SessionRead>, String> {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/tests/fixtures/dream_retrospective_sessions.json");
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let mut sessions: Vec<SessionRead> =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            for session in &mut sessions {
                session.overlap = session
                    .messages
                    .iter()
                    .filter(|m| m.ts <= since)
                    .cloned()
                    .collect();
                session.messages.retain(|m| m.ts > since);
            }
            Ok(sessions)
        }
    }

    struct FakeCarrier {
        answers: VecDeque<String>,
        during_model: Option<Box<dyn FnOnce() + Send>>,
        requests: Vec<ChildRequest>,
    }
    impl DreamCarrier for FakeCarrier {
        async fn open(&mut self, request: &ChildRequest) -> Result<String, CarrierError> {
            self.requests.push(request.clone());
            Ok(format!("child-{}", self.requests.len()))
        }
        async fn complete(
            &mut self,
            _: &str,
            _: &ChildRequest,
        ) -> Result<Completion, CarrierError> {
            if let Some(callback) = self.during_model.take() {
                callback();
            }
            let text = self
                .answers
                .pop_front()
                .expect("durable window must not request another model response");
            Ok(Completion {
                text,
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
            let root = std::env::temp_dir().join("magic-context/i5-5e");
            std::fs::create_dir_all(&root).unwrap();
            let dir = tempfile::Builder::new()
                .prefix("dream_retrospective-host-")
                .tempdir_in(root)
                .unwrap();
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let cortexkit_store_types::StorageBackend::Sqlite { path } = &descriptor.backend else {
                panic!("sqlite fixture required")
            };
            let context_path = PathBuf::from(path).with_file_name("context.db");
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let time = Arc::new(Time(AtomicI64::new(1_000)));
            let control = Arc::new(Control::default());
            let scope = StoreScope {
                project: ProjectId("project".into()),
                session: SessionId("parent".into()),
                generation: Generation(1),
            };
            let context = Arc::new(TaskContext {
                task,
                scope: scope.clone(),
                config: Arc::new(CapturedConfig {
                    activated: true,
                    route: crate::McModuleConfig::default(),
                    effective: json!({}),
                    harness: "opencode".into(),
                    directory: dir.path().into(),
                }),
                domain_lease: store
                    .acquire_dream_domain(&task.lease_key("project"), "holder", 1_000)
                    .unwrap()
                    .unwrap(),
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
                let content = "Keep durable pre-existing history";
                tx.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,source_session_id,first_seen_at,created_at,updated_at,last_seen_at) VALUES(1,'project','PROJECT_RULES',?1,?2,'older',1,1,1,1)", params![content,mc_store::compute_normalized_memory_hash(content)])?;
                tx.execute("INSERT INTO memory_history(memory_id,revision,previous_text,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(1,1,'original text',1,'edit','[]','[]','older')", [])?;
                tx.execute("INSERT INTO memory_journal(project_path,decision_key,operation,receipt_json,applied_at) VALUES('project','older','edit','{}',1)", [])?;
                tx.execute("INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES(1,?1,'model')", [vec![0_u8;8]])?;
                tx.execute("INSERT INTO session_meta(session_id,served_prefix) VALUES ('parent','frozen prefix')", [])?;
                tx.execute("INSERT INTO session_render_cache(session_id,cache_key,value) VALUES ('parent','cached_m0_bytes',?1)", [b"frozen bytes".as_slice()])?;
                tx.execute("INSERT INTO project_state(project_path,project_memory_epoch) VALUES('project',7)", [])?;
                if task == TaskName::ReviewUserMemories {
                    for id in 1..=3 {
                        tx.execute("INSERT INTO user_memory_candidates(id,content,session_id,created_at,source_compartment_start,source_compartment_end) VALUES(?1,'Prefers bounded checks',?2,1,10,20)", params![id,format!("source-{id}")])?;
                    }
                    tx.execute("INSERT INTO user_memories(id,content,status,promoted_at,created_at,updated_at) VALUES(1,'Prefers long reports','active',1,1,1),(2,'Likes guesses','active',1,1,1)", [])?;
                }
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
            let answers = if self.context.task == TaskName::Retrospective {
                vec!["y: 1, 2".into(), r#"<learnings><learning route="memory" category="PROJECT_RULES">Run focused verification before presenting completed implementation work</learning><learning route="observation">Prefers small independently reviewable changes</learning><learning route="observation">Expects evidence with completion summaries</learning></learnings>"#.into()]
            } else {
                vec![r#"{"promote":[{"content":"Prefers independently reviewable changes","candidate_ids":[1,2]}],"update_existing":[{"memory_id":1,"content":"Prefers concise evidence","candidate_ids":[3]}],"dismiss_existing":[{"memory_id":2}],"consume_candidate_ids":[1,2,3]}"#.into()]
            };
            FakeCarrier {
                answers: answers.into(),
                during_model: None,
                requests: Vec::new(),
            }
        }

        fn scalar(&self, sql: &str) -> i64 {
            self.store
                .with_context_read(|db| db.query_row(sql, [], |r| r.get(0)))
                .unwrap()
        }
        fn durable_bytes(&self) -> String {
            self.store
                .with_context_read(|db| {
                    let mut values = Vec::new();
                    for table in [
                        "memories",
                        "memory_history",
                        "memory_journal",
                        "memory_decision_receipts",
                        "memory_embeddings",
                        "user_memory_candidates",
                        "user_memories",
                        "retrospective_processed_windows",
                        "task_schedule_state",
                        "project_state",
                        "session_meta",
                    ] {
                        let mut stmt = db.prepare(&format!("SELECT * FROM {table} ORDER BY 1"))?;
                        let count = stmt.column_count();
                        let rows = stmt
                            .query_map([], |row| {
                                (0..count)
                                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                                    .collect::<rusqlite::Result<Vec<_>>>()
                            })?
                            .collect::<rusqlite::Result<Vec<_>>>()?;
                        values.push(format!("{table}:{rows:?}"));
                    }
                    Ok(values.join("\n"))
                })
                .unwrap()
        }

        fn host(&self, carrier: FakeCarrier) -> RetrospectiveHost<FakeCarrier> {
            RetrospectiveHost::new(carrier, self.store.clone(), self.context.clone())
        }
    }

    async fn run(host: &mut RetrospectiveHost<FakeCarrier>) -> Result<bool, HostError> {
        if host.context.task == TaskName::Retrospective {
            host.run_retrospective(&FixtureReader, &ScanOptions::default(), true)
                .await
                .map(|r| r.is_some())
        } else {
            host.run_user_review(3).await.map(|r| r.is_some())
        }
    }

    #[tokio::test]
    async fn dream_host_create_placement_and_hook_uses_run_authority() {
        use mc_store::memory_levels::*;
        let f = Fixture::new(TaskName::Retrospective);
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = events.clone();
        f.store
            .set_memory_create_hook(Some(std::sync::Arc::new(move |_, event| {
                captured.lock().unwrap().push(event.clone());
                Ok(())
            })));
        let authority = RunAuthority {
            project_id: Some("run-project".into()),
            profile: Some(OriginProfile {
                name: "@cortexkit/memory-swe".into(),
                version: "1.0.0".into(),
                digest: "run-profile".into(),
            }),
            state: "resolved".into(),
            snapshot_digest: Some("run-snapshot".into()),
            category_ids: std::collections::BTreeMap::from([(
                "PROJECT_RULES".into(),
                "swe:project-rules".into(),
            )]),
        };
        let mut host = f.host(f.carrier()).with_authority(Some(authority));
        let result = host
            .run_retrospective(&FixtureReader, &ScanOptions::default(), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.memory_written, 1);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.actor, Actor::Dreamer);
        assert_eq!(event.kind, CreateKind::Create);
        assert_eq!(event.session_id, None);
        assert_eq!(event.ordinals, Vec::<i64>::new());
        assert_eq!(
            event.owner,
            Some(Owner {
                kind: "project".into(),
                id: "run-project".into()
            })
        );
        assert_eq!(event.writer_project_id.as_deref(), Some("run-project"));
        assert_eq!(
            event.origin_profile.as_ref().unwrap().name,
            "@cortexkit/memory-swe"
        );
        assert_eq!(
            event.effective_category_id.as_deref(),
            Some("swe:project-rules")
        );
        assert_eq!(event.snapshot_digest.as_deref(), Some("run-snapshot"));
        let conn = rusqlite::Connection::open(&f.context_path).unwrap();
        assert_eq!(
            read_placement(&conn, event.memory_id)
                .unwrap()
                .unwrap()
                .owner,
            event.owner.clone().unwrap()
        );
    }

    #[tokio::test]
    async fn dream_retrospective_effects_and_watermark_commit_together() {
        let f = Fixture::new(TaskName::Retrospective);
        let mut host = f.host(f.carrier());
        let result = host
            .run_retrospective(&FixtureReader, &ScanOptions::default(), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.memory_written, 1);
        assert_eq!(result.observations_inserted, 2);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_placement"), 0);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_ops"), 0);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_outbox"), 0);
        assert_eq!(
            f.scalar("SELECT retrospective_watermark_ms FROM task_schedule_state"),
            300
        );
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM retrospective_processed_windows"),
            1
        );
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM memory_journal WHERE operation='agent_save'"),
            1
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memories WHERE source_session_id='source-session' AND source_type='dreamer' AND metadata_json='{\"source\":\"retrospective\"}'"),1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memory_candidates WHERE session_id='source-session' AND source_compartment_start IS NULL"),2);
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM memory_history WHERE previous_text='original text'"),
            1
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_embeddings"), 1);
        assert_eq!(
            f.scalar("SELECT project_memory_epoch FROM project_state WHERE project_path='project'"),
            7
        );
        let served: (String,Vec<u8>) = f.store.with_context_read(|db| db.query_row("SELECT served_prefix,(SELECT value FROM session_render_cache WHERE session_id=session_meta.session_id AND cache_key='cached_m0_bytes') FROM session_meta WHERE session_id='parent'",[],|r| Ok((r.get(0)?,r.get(1)?)))).unwrap();
        assert_eq!(served, ("frozen prefix".into(), b"frozen bytes".to_vec()));
        assert_eq!(host.attempts().len(), 2);
        for request in &host.carrier.requests {
            assert!(!request.prompt.contains("FOREIGN SECRET"));
            assert_eq!(request.parent_session_id, "parent");
            assert_eq!(request.directory, f.dir.path());
        }
    }

    #[tokio::test]
    async fn dream_retrospective_review_commits_profile_journal_and_provenance() {
        let f = Fixture::new(TaskName::ReviewUserMemories);
        assert!(run(&mut f.host(f.carrier())).await.unwrap());
        assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memory_candidates"), 0);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memories"), 3);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memories WHERE id=1 AND content='Prefers concise evidence'"),1);
        assert_eq!(
            f.scalar("SELECT COUNT(*) FROM user_memories WHERE id=2 AND status='dismissed'"),
            1
        );
        assert_eq!(f.store.user_profile_version().unwrap(), 1);
        let provenance: String = f
            .store
            .with_context_read(|db| {
                db.query_row(
                    "SELECT source_candidate_provenance FROM user_memories WHERE id=3",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&provenance).unwrap(),
            json!([
                {"candidate_id":1,"session_id":"source-1","source_compartment_start":10,"source_compartment_end":20},
                {"candidate_id":2,"session_id":"source-2","source_compartment_start":10,"source_compartment_end":20}
            ])
        );
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal WHERE operation='user_profile_review' AND before_json LIKE '%Prefers long reports%' AND after_json LIKE '%Prefers concise evidence%' AND receipt_json LIKE '%source-3%'"),1);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM task_schedule_state WHERE project_path='__global__' AND last_checked_commit LIKE '%reviewDecisionKey%'"),1);
    }

    #[tokio::test]
    async fn dream_retrospective_stolen_domain_has_zero_writes() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            let before = f.durable_bytes();
            let mut carrier = f.carrier();
            let store = f.store.clone();
            let lease = f.context.domain_lease.clone();
            carrier.during_model = Some(Box::new(move || {
                assert!(store.release_dream_domain(&lease).unwrap());
                store
                    .acquire_dream_domain(&lease.key, "successor", 1_001)
                    .unwrap()
                    .unwrap();
            }));
            assert!(run(&mut f.host(carrier)).await.is_err());
            assert_eq!(f.durable_bytes(), before, "{task:?}");
        }
    }

    #[tokio::test]
    async fn dream_retrospective_expired_domain_has_zero_writes() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            let before = f.durable_bytes();
            let mut carrier = f.carrier();
            let time = f.time.clone();
            let expiry = f.context.domain_lease.expires_at_ms;
            carrier.during_model = Some(Box::new(move || {
                time.0.store(expiry, Ordering::SeqCst);
            }));
            assert!(run(&mut f.host(carrier)).await.is_err());
            assert_eq!(f.durable_bytes(), before, "{task:?}");
        }
    }

    struct LoseTaskOnWrite {
        inner: SqliteContextDomain,
        armed: Arc<AtomicBool>,
        control: Arc<Control>,
    }
    impl ContextDomain for LoseTaskOnWrite {
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
    async fn dream_retrospective_task_loss_inside_writer_has_zero_writes() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            let before = f.durable_bytes();
            let armed = Arc::new(AtomicBool::new(false));
            f.store.install_context_domain(Arc::new(LoseTaskOnWrite {
                inner: SqliteContextDomain::open(&f.context_path).unwrap(),
                armed: armed.clone(),
                control: f.control.clone(),
            }));
            let mut carrier = f.carrier();
            carrier.during_model = Some(Box::new(move || {
                armed.store(true, Ordering::SeqCst);
            }));
            assert!(run(&mut f.host(carrier)).await.is_err());
            assert!(f.control.0.load(Ordering::SeqCst));
            assert_eq!(f.durable_bytes(), before, "{task:?}");
        }
    }

    #[tokio::test]
    async fn dream_retrospective_changed_input_window_is_not_applied() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            let store = f.store.clone();
            let mut carrier = f.carrier();
            carrier.during_model = Some(Box::new(move || {
                store.with_context_conn_for_test(|tx| {
                    if task == TaskName::Retrospective {
                        tx.execute("INSERT INTO task_schedule_state(project_path,task,retrospective_watermark_ms) VALUES('project','retrospective',250)", [])?;
                    } else {
                        tx.execute("UPDATE user_memory_candidates SET content='New observation' WHERE id=1", [])?;
                    }
                    Ok(())
                }).unwrap();
            }));
            assert!(!run(&mut f.host(carrier)).await.unwrap());
            assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal"), 1);
            assert_eq!(f.scalar("SELECT COUNT(*) FROM memories"), 1);
            assert_eq!(
                f.scalar("SELECT COUNT(*) FROM retrospective_processed_windows"),
                0
            );
            if task == TaskName::Retrospective {
                assert_eq!(
                    f.scalar("SELECT retrospective_watermark_ms FROM task_schedule_state"),
                    250
                );
                assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memory_candidates"), 0);
            } else {
                assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memory_candidates"), 3);
                assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memories"), 2);
                assert_eq!(f.store.user_profile_version().unwrap(), 0);
            }
        }
    }

    #[tokio::test]
    async fn dream_retrospective_mid_batch_failure_rolls_back_effects_and_watermark() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            let before = f.durable_bytes();
            let trigger = if task == TaskName::Retrospective {
                "CREATE TRIGGER fail_second_observation BEFORE INSERT ON user_memory_candidates WHEN NEW.content='Expects evidence with completion summaries' BEGIN SELECT RAISE(ABORT,'second observation failed'); END;"
            } else {
                "CREATE TRIGGER fail_second_profile BEFORE UPDATE ON user_memories WHEN OLD.id=1 BEGIN SELECT RAISE(ABORT,'profile update failed'); END;"
            };
            f.store
                .with_context_conn_for_test(|tx| tx.execute_batch(trigger))
                .unwrap();
            let error = run(&mut f.host(f.carrier())).await.unwrap_err();
            assert!(
                format!("{error:?}").contains(if task == TaskName::Retrospective {
                    "second observation failed"
                } else {
                    "profile update failed"
                })
            );
            assert_eq!(f.durable_bytes(), before, "{task:?}");
        }
    }

    #[tokio::test]
    async fn dream_retrospective_checkpoint_failure_rolls_back_completed_effects() {
        let f = Fixture::new(TaskName::Retrospective);
        let before = f.durable_bytes();
        f.store.with_context_conn_for_test(|tx| tx.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE INSERT ON task_schedule_state BEGIN SELECT RAISE(ABORT,'checkpoint failed'); END;")).unwrap();
        assert!(run(&mut f.host(f.carrier())).await.is_err());
        assert_eq!(f.durable_bytes(), before);
    }

    #[tokio::test]
    async fn dream_retrospective_durable_window_replay_after_reopen_is_noop() {
        for task in [TaskName::Retrospective, TaskName::ReviewUserMemories] {
            let f = Fixture::new(task);
            assert!(run(&mut f.host(f.carrier())).await.unwrap());
            let before = f.durable_bytes();
            let Fixture {
                dir,
                store,
                context,
                ..
            } = f;
            drop(store);
            let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
            let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
            let mut host = RetrospectiveHost::new(
                FakeCarrier {
                    answers: VecDeque::new(),
                    during_model: None,
                    requests: Vec::new(),
                },
                store.clone(),
                context.clone(),
            );
            assert!(!run(&mut host).await.unwrap());
            let f = Fixture {
                dir,
                context_path: PathBuf::new(),
                store,
                context,
                time: Arc::new(Time(AtomicI64::new(1_000))),
                control: Arc::new(Control::default()),
            };
            assert_eq!(f.durable_bytes(), before, "{task:?}");
        }
    }

    #[tokio::test]
    async fn dream_retrospective_review_prunes_ttl_before_failed_model() {
        let f = Fixture::new(TaskName::ReviewUserMemories);
        f.store.with_context_conn_for_test(|tx| {
            tx.execute("INSERT INTO user_memory_candidates(content,session_id,created_at) VALUES('expired','source-old',-3000000000)", [])?;
            Ok(())
        }).unwrap();
        let mut carrier = f.carrier();
        carrier.answers = vec!["invalid response".into()].into();
        assert!(run(&mut f.host(carrier)).await.is_err());
        assert_eq!(f.scalar("SELECT COUNT(*) FROM user_memory_candidates"), 3);
        assert_eq!(f.scalar("SELECT COUNT(*) FROM memory_journal"), 1);
        assert_eq!(f.store.user_profile_version().unwrap(), 0);
    }

    /// Every row of `sql` as a JSON object keyed by column name.
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

    /// testdata/dream_tasks/retrospective.json is what the TypeScript dreamer's
    /// retrospective (gen/gen-dream-retrospective-golden.ts) read through its
    /// production OpenCode provider, sent to the model and wrote, over two runs on
    /// one database. The same messages, archived, go through the production
    /// archive reader and this host.
    #[tokio::test]
    async fn retrospective_reads_decides_and_writes_as_the_typescript_dreamer() {
        use crate::dream_dispatch::session_reader;
        let golden: Value = serde_json::from_str(include_str!(
            "../../testdata/dream_tasks/retrospective.json"
        ))
        .unwrap();
        assert_eq!(golden["project"], "project");
        let f = Fixture::new(TaskName::Retrospective);
        let now = golden["now"].as_i64().unwrap();
        f.time.0.store(now, Ordering::SeqCst);
        f.store
            .with_context_conn_for_test(|tx| {
                session_reader::install_archive_for_test(tx)?;
                for s in golden["sessions"].as_array().unwrap() {
                    tx.execute("INSERT INTO session_projects(session_id,harness,project_path,updated_at) VALUES(?1,'opencode',?2,0)",
                        params![s["session"].as_str(), s["project"].as_str()])?;
                    tx.execute("INSERT INTO session_meta(session_id,harness,is_subagent) VALUES(?1,'opencode',?2)",
                        params![s["session"].as_str(), s["subagent"].as_i64()])?;
                }
                Ok(())
            })
            .unwrap();
        let settings = json!({"dreamer": {"tasks": {
            "retrospective": {"recency_days": 30},
            "review-user-memories": {"schedule": "0 4 * * *"}}}});
        for (index, run) in golden["runs"].as_array().unwrap().iter().enumerate() {
            f.store
                .with_context_conn_for_test(|tx| {
                    for row in run["archived"].as_array().unwrap() {
                        let session = row["sessionId"].as_str().unwrap();
                        session_reader::archive_for_test(tx, session, &row["message"])?;
                        tx.execute("INSERT INTO schema_migrations_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER) > CAST(value AS INTEGER)",
                            params![format!("retrospective_activity:{session}"), row["message"]["createdAt"].as_i64().unwrap().to_string()])?;
                    }
                    Ok(())
                })
                .unwrap();
            let mut carrier = f.carrier();
            carrier.answers = [&run["answer"]["gate"], &run["answer"]["deepen"]]
                .into_iter()
                .filter_map(|a| a.as_str().map(str::to_owned))
                .collect();
            let (reader, options, collection) =
                session_reader::retrospective_inputs(f.store.clone(), &settings, "opencode", now);
            assert!(collection);
            let mut host = f.host(carrier);
            host.run_retrospective(&reader, &options, collection)
                .await
                .unwrap();
            let requests = &host.carrier.requests;
            assert_eq!(json!(requests.len()), run["modelCalls"], "run {index}");
            let gate = run["gateUserText"].as_str().unwrap();
            assert!(
                requests[0].prompt.ends_with(gate),
                "run {index} gate lines differ:\n{}\n---\n{gate}",
                requests[0].prompt
            );
            if let Some(window) = run["frictionWindow"].as_str() {
                assert!(
                    requests[1]
                        .prompt
                        .contains(&format!("### Friction window\n{window}\n\n")),
                    "run {index} friction window differs:\n{}",
                    requests[1].prompt
                );
            }
            assert_eq!(
                json!(f.scalar("SELECT retrospective_watermark_ms FROM task_schedule_state WHERE project_path='project' AND task='retrospective'")),
                run["watermark"],
                "run {index}"
            );
            // Row 1 is the fixture's own pre-existing memory.
            assert_eq!(
                rows(&f, "SELECT project_path,category,content,source_session_id,source_type,metadata_json,status FROM memories WHERE id > 1 ORDER BY id"),
                run["memories"],
                "run {index}"
            );
            assert_eq!(
                rows(&f, "SELECT content,session_id,created_at,source_compartment_start,source_compartment_end FROM user_memory_candidates ORDER BY id"),
                run["candidates"],
                "run {index}"
            );
            assert_eq!(
                rows(&f, "SELECT project_path,window_key FROM retrospective_processed_windows ORDER BY window_key"),
                run["processedWindows"],
                "run {index}"
            );
        }
    }

    /// testdata/dream_tasks/review_user_memories.json is what the TypeScript
    /// dreamer's review-user-memories task (gen/gen-dream-review-golden.ts) wrote
    /// for the same candidate pool, profile and reviewer answer.
    #[tokio::test]
    async fn user_review_rows_match_the_typescript_reviewer() {
        let golden: Vec<Value> = serde_json::from_str(include_str!(
            "../../testdata/dream_tasks/review_user_memories.json"
        ))
        .unwrap();
        assert_eq!(golden.len(), 3);
        for case in golden {
            let name = case["name"].as_str().unwrap();
            let f = Fixture::new(TaskName::ReviewUserMemories);
            f.store
                .with_context_conn_for_test(|tx| {
                    tx.execute_batch(
                        "DELETE FROM user_memory_candidates; DELETE FROM user_memories;",
                    )?;
                    for c in case["candidates"].as_array().unwrap() {
                        tx.execute("INSERT INTO user_memory_candidates(id,content,session_id,created_at,source_compartment_start,source_compartment_end) VALUES(?1,?2,?3,?4,?5,?6)",
                            params![c["id"].as_i64(), c["content"].as_str(), c["session_id"].as_str(), c["created_at"].as_i64(), c["source_compartment_start"].as_i64(), c["source_compartment_end"].as_i64()])?;
                    }
                    for m in case["profile"].as_array().unwrap() {
                        tx.execute("INSERT INTO user_memories(id,content,status,promoted_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6)",
                            params![m["id"].as_i64(), m["content"].as_str(), m["status"].as_str(), m["promoted_at"].as_i64(), m["created_at"].as_i64(), m["updated_at"].as_i64()])?;
                    }
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                f.time.0.load(Ordering::SeqCst),
                1000,
                "the golden writes at 1000 ms"
            );
            let mut carrier = f.carrier();
            carrier.answers = case["answer"]
                .as_str()
                .map(|a| vec![a.to_owned()])
                .unwrap_or_default()
                .into();
            let mut host = f.host(carrier);
            let result = host
                .run_user_review(case["threshold"].as_u64().unwrap() as usize)
                .await
                .unwrap();
            assert_eq!(
                json!(host.carrier.requests.len()),
                case["modelCalls"],
                "{name}"
            );
            assert_eq!(
                serde_json::to_value(result.unwrap_or_default()).unwrap(),
                case["result"],
                "{name}"
            );
            assert_eq!(
                rows(&f, "SELECT id,content,status,promoted_at,source_candidate_ids,source_candidate_provenance,created_at,updated_at FROM user_memories ORDER BY id"),
                case["userMemories"],
                "{name}"
            );
            let remaining: Vec<i64> = rows(&f, "SELECT id FROM user_memory_candidates ORDER BY id")
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].as_i64().unwrap())
                .collect();
            assert_eq!(json!(remaining), case["remainingCandidateIds"], "{name}");
            assert_eq!(
                json!(f.store.user_profile_version().unwrap()),
                case["profileVersion"],
                "{name}"
            );
        }
    }
}
