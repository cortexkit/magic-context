//! ck-mc's own project scopes, under which its child sessions run.
//!
//! A summarizer run happens in a child session of ck-mc's own on the
//! session's runner. The runner creates that child on its first send, in the
//! folder of the scope the route was opened under, and refuses a scope with
//! no folder (THALAMUS's runner: `invalid_params {field: scope, problem:
//! workdir_required}`). ck-mc scopes carry the project folder as `workdir`
//! and list the runners allowed to use them. Lab sessions offering
//! `sidekick` use a separate Worker scope for the same folder.
//!
//! The daemon's `scope.sync` replaces an owner's whole set of scopes, so
//! every sync carries the ordinary projects seen so far and active lab scopes.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use subc_client_rs::{async_trait, ModuleHandle, ScopeCallError};
use subc_protocol::scope::{
    ScopeCarrier, ScopeKind, ScopeRecord, ScopeRecordOutcome, ScopeSelector,
};
use subc_protocol::Principal;

tokio::task_local! {
    /// An opted-in lab uses a Worker scope for the runner session, including
    /// its catalog preflight and cancellation. Reader discovery runs first
    /// under the ordinary scope.
    /// A separately spawned task does not inherit this task-local value.
    pub(crate) static LAB_WORKER_SCOPE: Arc<WorkerScope>;
}

pub(crate) struct WorkerScopeGuard(pub(crate) Arc<WorkerScope>);

impl Drop for WorkerScopeGuard {
    fn drop(&mut self) {
        // If the run unwinds before it can sync, leave removal to the next sync.
        self.0.mark_ended();
    }
}

/// Identity and lifetime of one Worker scope. An ended scope cannot be reopened.
pub struct WorkerScope {
    key: ScopeKey,
    attempted: AtomicBool,
    ended: Mutex<Option<ScopeError>>,
    pub(crate) capabilities: Arc<crate::runner_capabilities::RunnerCapabilities>,
}

impl WorkerScope {
    pub(crate) fn check_project_id(project: &str) -> Result<(), ScopeError> {
        if !(1..=128).contains(&project.len()) || !project.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(ScopeError {
                code: "invalid_worker_project_id".into(),
                message:
                    "the sidekick project id must be 1 to 128 printable non-space ASCII characters"
                        .into(),
            });
        }
        Ok(())
    }

    pub(crate) fn new(root: &str, project: &str, run: &str) -> Result<Arc<Self>, ScopeError> {
        Self::check_project_id(project)?;
        Ok(Arc::new(Self {
            key: (root.into(), Some((project.into(), run.into()))),
            attempted: AtomicBool::new(false),
            ended: Mutex::new(None),
            capabilities: Arc::default(),
        }))
    }

    #[cfg(test)]
    pub(crate) fn project(&self) -> &str {
        &self.key.1.as_ref().expect("Worker scope identity").0
    }

    fn end(&self, error: ScopeError) {
        self.ended
            .lock()
            .expect("Worker scope lifetime")
            .get_or_insert(error);
    }

    fn mark_ended(&self) {
        self.end(ScopeError {
            code: "worker_scope_ended".into(),
            message: "the lab Worker scope has ended".into(),
        });
    }

    pub(crate) fn check_live(&self) -> Result<(), ScopeError> {
        match self.ended.lock().expect("Worker scope lifetime").as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

/// The runners a child scope lists as carriers: they may open routes under
/// it and run sessions in its folder.
pub const CARRIERS: [&str; 2] = ["thalamus-harness", "broca"];

/// A child scope that could not be made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeError {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Where scopes are published: the daemon through ck-mc's serving handle,
/// or a stand-in in tests.
#[async_trait]
pub trait ScopePublisher: Send + Sync {
    async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError>;
}

struct ModulePublisher(ModuleHandle);

#[async_trait]
impl ScopePublisher for ModulePublisher {
    async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError> {
        let expected: Vec<(String, u64)> = scopes
            .iter()
            .map(|scope| (scope.scope_ref.clone(), scope.scope_epoch))
            .collect();
        let reply = self
            .0
            .scope_sync(generation, scopes)
            .await
            .map_err(|error| match error {
                ScopeCallError::Refused { code, message } => ScopeError { code, message },
                other => ScopeError {
                    code: "child_scope_sync_failed".into(),
                    message: other.to_string(),
                },
            })?;
        if reply.generation != generation || reply.results.len() != expected.len() {
            return Err(ScopeError {
                code: "child_scope_sync_protocol".into(),
                message: "scope.sync answered another generation or record count".into(),
            });
        }
        for (result, (scope_ref, epoch)) in reply.results.into_iter().zip(expected) {
            if result.outcome == ScopeRecordOutcome::Refused {
                return Err(ScopeError {
                    code: result.code.unwrap_or_else(|| "child_scope_refused".into()),
                    message: result
                        .message
                        .unwrap_or_else(|| "the daemon refused the child scope".into()),
                });
            }
            if result.scope_ref != scope_ref || result.scope_epoch != epoch {
                return Err(ScopeError {
                    code: "child_scope_sync_protocol".into(),
                    message: "scope.sync answered for another scope".into(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct State {
    generation: u64,
    /// The last sync was acknowledged, and covers `records`.
    synced: bool,
    records: BTreeMap<ScopeKey, Record>,
}

// Keep ordinary records in folder order; Worker keys also include the
// project ID and the lab run ID.
type ScopeKey = (String, Option<(String, String)>);

struct Record {
    wire: ScopeRecord,
    worker: Option<Arc<WorkerScope>>,
}

impl State {
    async fn publish(
        &mut self,
        publisher: &dyn ScopePublisher,
        pending: Option<(&ScopeKey, &Record)>,
    ) -> Result<(), ScopeError> {
        self.records.retain(|_, record| {
            record
                .worker
                .as_ref()
                .is_none_or(|worker| worker.check_live().is_ok())
        });
        let mut records: Vec<_> = self.records.iter().chain(pending).collect();
        if pending.is_some() {
            records.sort_by_key(|(key, _)| *key);
        }
        let records = records
            .into_iter()
            .map(|(_, record)| record.wire.clone())
            .collect();
        self.generation += 1;
        self.synced = false;
        publisher.sync(self.generation, records).await?;
        self.synced = true;
        Ok(())
    }

    // A full sync can install some records even when another was refused.
    // Reassert the ordinary records without any disposable Worker scopes.
    async fn publish_preserving_ordinary(
        &mut self,
        publisher: &dyn ScopePublisher,
        pending: Option<(&ScopeKey, &Record)>,
        worker_call: bool,
    ) -> Result<(), ScopeError> {
        let Err(error) = self.publish(publisher, pending).await else {
            return Ok(());
        };
        let mut dropped = Vec::new();
        let mut evict = |record: &Record, first_publication: bool| {
            if let Some(worker) = &record.worker {
                worker.end(if first_publication {
                    error.clone()
                } else {
                    ScopeError {
                        code: "worker_scope_evicted".into(),
                        message: format!(
                            "the lab Worker scope was dropped after scope.sync failed: {error}"
                        ),
                    }
                });
                dropped.push(record.wire.scope_ref.clone());
                true
            } else {
                false
            }
        };
        if let Some((_, pending)) = pending {
            evict(pending, true);
        }
        self.records.retain(|_, record| !evict(record, false));
        if dropped.is_empty() {
            return Err(error);
        }
        let fallback = self.publish(publisher, None).await;
        tracing::warn!(scopes = ?dropped, %error, retry_error = ?fallback.as_ref().err(),
            "ck-mc: dropped lab Worker scopes after scope.sync failed");
        if !worker_call && fallback.is_ok() {
            Ok(())
        } else {
            Err(error)
        }
    }
}

/// ck-mc's child scopes for this process.
pub struct ChildScopes {
    module_id: String,
    /// Unique to this process, so a new process never reuses a scope
    /// reference that an earlier process's last sync ended.
    incarnation: String,
    publisher: Mutex<Option<Arc<dyn ScopePublisher>>>,
    state: tokio::sync::Mutex<State>,
}

impl ChildScopes {
    pub fn new(module_id: impl Into<String>) -> Self {
        let start = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let incarnation =
            hex(&Sha256::digest(format!("{}:{start}", std::process::id())))[..32].to_owned();
        Self {
            module_id: module_id.into(),
            incarnation,
            publisher: Mutex::new(None),
            state: tokio::sync::Mutex::new(State::default()),
        }
    }

    /// The module id ck-mc runs under, as the daemon launched it.
    pub fn module_id(&self) -> &str {
        &self.module_id
    }

    /// Publish through the daemon from now on.
    pub fn install(&self, handle: ModuleHandle) {
        self.set_publisher(Arc::new(ModulePublisher(handle)));
    }

    pub fn set_publisher(&self, publisher: Arc<dyn ScopePublisher>) {
        *self.publisher.lock().expect("child scope publisher") = Some(publisher);
    }

    /// The next use syncs again, for example after the daemon answered
    /// `scope_not_synced`: it restarted and forgot ck-mc's scopes.
    pub async fn forget_sync(&self) {
        self.state.lock().await.synced = false;
    }

    /// The scope for `project_root`, published first when it is new. A lab
    /// run that requests `sidekick` gets its own Worker scope, which also
    /// names the project; every other caller gets the folder's ordinary one.
    pub async fn for_child(&self, project_root: &str) -> Result<ScopeSelector, ScopeError> {
        let worker = LAB_WORKER_SCOPE.try_with(Arc::clone).ok();
        if !Path::new(project_root).is_absolute() {
            return Err(ScopeError {
                code: "child_scope_invalid_workdir".into(),
                message: format!("{project_root} is not an absolute folder"),
            });
        }
        let key = match &worker {
            Some(worker) if worker.key.0 == project_root => worker.key.clone(),
            Some(_) => {
                return Err(ScopeError {
                    code: "worker_scope_workdir_mismatch".into(),
                    message: "the child folder is not the lab Worker scope's folder".into(),
                })
            }
            None => (project_root.into(), None),
        };
        let folder_digest = hex(&Sha256::digest(project_root.as_bytes()));
        let scope_ref = match &key.1 {
            Some((project, run)) => format!(
                "mc-child-lab-worker-{}-{}",
                self.incarnation,
                hex(&Sha256::digest(format!(
                    "{folder_digest}\0{project}\0{run}"
                )))
            ),
            None => format!("mc-child-project-{}-{folder_digest}", self.incarnation),
        };
        let selector = ScopeSelector::new(
            Principal::Reserved {
                module_id: self.module_id.clone(),
            },
            &scope_ref,
            Some(1),
        );
        let mut state = self.state.lock().await;
        if let Some(worker) = &worker {
            worker.check_live()?;
        }
        if state.synced && state.records.contains_key(&key) {
            return Ok(selector);
        }
        let publisher = self.publisher()?;
        let project_id = key.1.as_ref().map(|(project, _)| project.clone());
        let new_record = || {
            let kind = if worker.is_some() {
                ScopeKind::Worker
            } else {
                ScopeKind::Ephemeral
            };
            // The folder is kept exactly as the session's scope spelled
            // it, never normalized.
            let wire = ScopeRecord::new(scope_ref, 1, kind)
                .with_project_id(project_id)
                .with_workdir(Some(project_root.to_owned()))
                .with_carriers(
                    CARRIERS
                        .map(|module_id| {
                            ScopeCarrier::new(Principal::Reserved {
                                module_id: module_id.into(),
                            })
                        })
                        .into(),
                );
            Record {
                wire,
                worker: worker.clone(),
            }
        };
        if let Some(worker) = &worker {
            if state.records.contains_key(&key) {
                state
                    .publish_preserving_ordinary(publisher.as_ref(), None, true)
                    .await?;
            } else {
                // A timed-out caller can drop this future while the daemon
                // is publishing. Do not keep a Worker the daemon has not
                // acknowledged in `state.records`, where every later sync
                // would resend it; the run's teardown removes it at the daemon.
                let pending = new_record();
                worker.attempted.store(true, Ordering::Release);
                state
                    .publish_preserving_ordinary(publisher.as_ref(), Some((&key, &pending)), true)
                    .await?;
                state.records.insert(key, pending);
            }
        } else {
            // An ordinary record stays even when publication fails so a
            // later sync for another project never ends this one.
            state.records.entry(key).or_insert_with(new_record);
            state
                .publish_preserving_ordinary(publisher.as_ref(), None, false)
                .await?;
        }
        Ok(selector)
    }

    pub(crate) async fn end_worker_scope(&self, worker: &WorkerScope) -> Result<(), ScopeError> {
        let mut state = self.state.lock().await;
        worker.mark_ended();
        if state.records.remove(&worker.key).is_some() {
            state.synced = false;
        }
        if state.synced || !worker.attempted.load(Ordering::Acquire) {
            return Ok(());
        }
        let publisher = self.publisher()?;
        state
            .publish_preserving_ordinary(publisher.as_ref(), None, false)
            .await
    }

    fn publisher(&self) -> Result<Arc<dyn ScopePublisher>, ScopeError> {
        self.publisher
            .lock()
            .expect("child scope publisher")
            .clone()
            .ok_or_else(|| ScopeError {
                code: "child_scope_owner_unavailable".into(),
                message: "ck-mc is not serving yet".into(),
            })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::VecDeque;

    // Windows needs a drive prefix even for an absolute fixture that only
    // labels a mock publication and never touches the filesystem.
    macro_rules! fixture_workdir {
        ($path:literal) => {{
            #[cfg(windows)]
            let path = concat!("C:", $path);
            #[cfg(not(windows))]
            let path = $path;
            path
        }};
    }
    const WORK_A: &str = fixture_workdir!("/work/a");
    const WORK_B: &str = fixture_workdir!("/work/b");
    const WORK_LAB: &str = fixture_workdir!("/work/lab");
    const WORK_LAST: &str = fixture_workdir!("/work/last");
    pub(crate) const WORK_NEW: &str = fixture_workdir!("/work/new");
    pub(crate) const WORK_OLD: &str = fixture_workdir!("/work/old");
    pub(crate) const WORK_ORDINARY: &str = fixture_workdir!("/work/ordinary");

    #[derive(Default)]
    pub(crate) struct Recorder {
        pub(crate) syncs: Mutex<Vec<(u64, Vec<ScopeRecord>)>>,
        pub(crate) stall_workers: AtomicBool,
        pub(crate) reject_workers: AtomicBool,
        errors: Mutex<VecDeque<ScopeError>>,
    }

    fn refusal(code: &str) -> ScopeError {
        ScopeError {
            code: code.into(),
            message: "the scope fixture refused this sync".into(),
        }
    }

    #[async_trait]
    impl ScopePublisher for Recorder {
        async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError> {
            let has_worker = scopes.iter().any(|record| record.kind == ScopeKind::Worker);
            self.syncs.lock().unwrap().push((generation, scopes));
            if let Some(error) = self.errors.lock().unwrap().pop_front() {
                return Err(error);
            }
            if has_worker && self.reject_workers.load(Ordering::Relaxed) {
                return Err(refusal("worker_refused"));
            }
            if has_worker && self.stall_workers.load(Ordering::Relaxed) {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
    }

    fn setup() -> (ChildScopes, Arc<Recorder>) {
        let scopes = ChildScopes::new("magic-context");
        let recorder = Arc::new(Recorder::default());
        scopes.set_publisher(recorder.clone());
        (scopes, recorder)
    }

    async fn for_worker(
        scopes: &ChildScopes,
        worker: &Arc<WorkerScope>,
    ) -> Result<ScopeSelector, ScopeError> {
        LAB_WORKER_SCOPE
            .scope(worker.clone(), scopes.for_child(&worker.key.0))
            .await
    }

    #[tokio::test]
    async fn each_new_project_syncs_every_project_once() {
        let scopes = ChildScopes::new("magic-context");
        let recorder = Arc::new(Recorder::default());
        scopes.set_publisher(recorder.clone());
        let first = scopes.for_child(WORK_A).await.unwrap();
        assert_eq!(scopes.for_child(WORK_A).await.unwrap(), first);
        scopes.for_child(WORK_B).await.unwrap();
        let syncs = recorder.syncs.lock().unwrap().clone();
        assert_eq!(syncs.len(), 2, "a known project does not sync again");
        let (generation, records) = &syncs[1];
        assert_eq!(*generation, 2);
        let folders: Vec<_> = records
            .iter()
            .map(|record| record.workdir.clone().unwrap())
            .collect();
        assert_eq!(folders, [WORK_A, WORK_B]);
        assert_eq!(records[0].carriers.len(), 2);
        assert!(records
            .iter()
            .all(|record| record.kind == ScopeKind::Ephemeral && record.project_id.is_none()));
        scopes.forget_sync().await;
        scopes.for_child(WORK_A).await.unwrap();
        assert_eq!(
            recorder.syncs.lock().unwrap().len(),
            3,
            "a forgotten sync syncs again"
        );
    }

    #[tokio::test]
    async fn worker_projects_have_separate_scopes_in_the_same_folder() {
        let scopes = ChildScopes::new("magic-context");
        let recorder = Arc::new(Recorder::default());
        scopes.set_publisher(recorder.clone());
        let root = WORK_LAB;
        let plain = scopes.for_child(root).await.unwrap();
        let first = for_worker(
            &scopes,
            &WorkerScope::new(root, "project-a", "run-a").unwrap(),
        )
        .await
        .unwrap();
        let second = for_worker(
            &scopes,
            &WorkerScope::new(root, "project-b", "run-a").unwrap(),
        )
        .await
        .unwrap();
        assert_ne!(first, plain);
        assert_ne!(first, second);
        assert_eq!(scopes.for_child(root).await.unwrap(), plain);
        let syncs = recorder.syncs.lock().unwrap();
        assert_eq!(syncs.len(), 3);
        assert_eq!(syncs[0].1[0], syncs[2].1[0]);
        assert_eq!(syncs[2].1.len(), 3);
        for (record, project) in syncs[2]
            .1
            .iter()
            .zip([None, Some("project-a"), Some("project-b")])
        {
            assert_eq!(record.workdir.as_deref(), Some(root));
            assert_eq!(record.project_id.as_deref(), project);
            assert_eq!(record.carriers, syncs[0].1[0].carriers);
            assert_eq!(
                record.kind,
                if project.is_some() {
                    ScopeKind::Worker
                } else {
                    ScopeKind::Ephemeral
                }
            );
        }
    }

    #[tokio::test]
    async fn refused_worker_publication_leaves_ordinary_scopes_usable() {
        let (scopes, recorder) = setup();
        scopes.for_child(WORK_OLD).await.unwrap();
        recorder.reject_workers.store(true, Ordering::Relaxed);
        let worker = WorkerScope::new(WORK_LAB, "project", "run").unwrap();
        let error = for_worker(&scopes, &worker).await.unwrap_err();
        assert_eq!(error, refusal("worker_refused"));
        scopes.for_child(WORK_NEW).await.unwrap();

        let syncs = recorder.syncs.lock().unwrap();
        assert_eq!(syncs.len(), 4);
        assert_eq!(syncs[1].1[0].kind, ScopeKind::Worker);
        assert_eq!(syncs[2], (3, syncs[0].1.clone()));
        assert_eq!(ordinary_folders(&syncs[3].1), [WORK_NEW, WORK_OLD]);
    }

    #[tokio::test]
    async fn ordinary_records_stay_after_a_failed_sync() {
        let (scopes, recorder) = setup();
        recorder
            .errors
            .lock()
            .unwrap()
            .push_back(refusal("ordinary_refused"));
        let error = scopes.for_child(WORK_OLD).await.unwrap_err();
        assert_eq!(error, refusal("ordinary_refused"));
        scopes.for_child(WORK_NEW).await.unwrap();

        let syncs = recorder.syncs.lock().unwrap();
        assert_eq!(syncs.len(), 2);
        assert_eq!(ordinary_folders(&syncs[1].1), [WORK_NEW, WORK_OLD]);
    }

    #[tokio::test]
    async fn ordinary_sync_evicts_a_worker_that_can_no_longer_be_published() {
        let (scopes, recorder) = setup();
        let worker = WorkerScope::new(WORK_LAB, "project", "run").unwrap();
        for_worker(&scopes, &worker).await.unwrap();
        recorder.reject_workers.store(true, Ordering::Relaxed);
        scopes.for_child(WORK_NEW).await.unwrap();
        let error = for_worker(&scopes, &worker).await.unwrap_err();
        assert_eq!(error.code, "worker_scope_evicted");
        assert!(error.message.contains("worker_refused"), "{error}");

        let syncs = recorder.syncs.lock().unwrap();
        assert_eq!(
            syncs.len(),
            3,
            "an evicted Worker does not get a new publication"
        );
        assert_eq!(ordinary_folders(&syncs[2].1), [WORK_NEW]);
    }

    #[tokio::test]
    async fn ordinary_records_stay_when_retrying_without_workers_also_fails() {
        let (scopes, recorder) = setup();
        scopes.for_child(WORK_OLD).await.unwrap();
        let worker = WorkerScope::new(WORK_LAB, "project", "run").unwrap();
        for_worker(&scopes, &worker).await.unwrap();
        recorder
            .errors
            .lock()
            .unwrap()
            .extend([refusal("first_error"), refusal("retry_error")]);
        assert_eq!(
            scopes.for_child(WORK_NEW).await.unwrap_err(),
            refusal("first_error")
        );
        let error = for_worker(&scopes, &worker).await.unwrap_err();
        assert_eq!(error.code, "worker_scope_evicted");
        scopes.for_child(WORK_LAST).await.unwrap();

        let syncs = recorder.syncs.lock().unwrap();
        assert_eq!(syncs.len(), 5);
        assert_eq!(ordinary_folders(&syncs[3].1), [WORK_NEW, WORK_OLD]);
        assert_eq!(
            ordinary_folders(&syncs[4].1),
            [WORK_LAST, WORK_NEW, WORK_OLD]
        );
    }

    fn ordinary_folders(records: &[ScopeRecord]) -> Vec<&str> {
        records
            .iter()
            .map(|record| {
                assert_eq!(record.kind, ScopeKind::Ephemeral);
                record.workdir.as_deref().unwrap()
            })
            .collect()
    }

    #[tokio::test]
    async fn a_relative_folder_or_no_daemon_is_refused_by_name() {
        let scopes = ChildScopes::new("magic-context");
        let error = scopes.for_child("work/a").await.unwrap_err();
        assert_eq!(error.code, "child_scope_invalid_workdir");
        let error = scopes.for_child(WORK_A).await.unwrap_err();
        assert_eq!(error.code, "child_scope_owner_unavailable");
    }
}
