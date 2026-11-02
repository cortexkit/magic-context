//! ck-mc's own project scopes, under which its summarizer runs.
//!
//! A summarizer run happens in a child session of ck-mc's own on the
//! session's runner. The runner creates that child on its first send, in the
//! folder of the scope the route was opened under, and refuses a scope with
//! no folder (THALAMUS's runner: `invalid_params {field: scope, problem:
//! workdir_required}`). So ck-mc owns one scope per project folder, with that
//! folder as its `workdir`, and lists the runners that may carry it.
//!
//! The daemon's `scope.sync` replaces an owner's whole set of scopes, so
//! every sync carries every project seen so far in this process.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use subc_client_rs::{async_trait, ModuleHandle, ScopeCallError};
use subc_protocol::scope::{
    ScopeCarrier, ScopeKind, ScopeRecord, ScopeRecordOutcome, ScopeSelector,
};
use subc_protocol::Principal;

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
    /// Every project's scope, by folder.
    records: BTreeMap<String, ScopeRecord>,
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

    /// The scope for `project_root`, published first when it is new.
    pub async fn for_project(&self, project_root: &str) -> Result<ScopeSelector, ScopeError> {
        if !Path::new(project_root).is_absolute() {
            return Err(ScopeError {
                code: "child_scope_invalid_workdir".into(),
                message: format!("{project_root} is not an absolute folder"),
            });
        }
        let scope_ref = format!(
            "mc-child-project-{}-{}",
            self.incarnation,
            hex(&Sha256::digest(project_root.as_bytes()))
        );
        let selector = ScopeSelector::new(
            Principal::Reserved {
                module_id: self.module_id.clone(),
            },
            &scope_ref,
            Some(1),
        );
        let mut state = self.state.lock().await;
        if state.synced && state.records.contains_key(project_root) {
            return Ok(selector);
        }
        let publisher = self
            .publisher
            .lock()
            .expect("child scope publisher")
            .clone()
            .ok_or_else(|| ScopeError {
                code: "child_scope_owner_unavailable".into(),
                message: "ck-mc is not serving yet".into(),
            })?;
        state
            .records
            .entry(project_root.to_owned())
            .or_insert_with(|| {
                // The folder is kept exactly as the session's scope spelled
                // it, never normalized.
                ScopeRecord::new(scope_ref, 1, ScopeKind::Ephemeral)
                    .with_workdir(Some(project_root.to_owned()))
                    .with_carriers(
                        CARRIERS
                            .map(|module_id| {
                                ScopeCarrier::new(Principal::Reserved {
                                    module_id: module_id.into(),
                                })
                            })
                            .into(),
                    )
            });
        state.generation += 1;
        state.synced = false;
        // The records stay even when the sync fails, so a later sync for
        // another project never ends this one.
        publisher
            .sync(state.generation, state.records.values().cloned().collect())
            .await?;
        state.synced = true;
        Ok(selector)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(u64, Vec<ScopeRecord>)>>);

    #[async_trait]
    impl ScopePublisher for Recorder {
        async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError> {
            self.0.lock().unwrap().push((generation, scopes));
            Ok(())
        }
    }

    #[tokio::test]
    async fn each_new_project_syncs_every_project_once() {
        let scopes = ChildScopes::new("magic-context");
        let recorder = Arc::new(Recorder::default());
        scopes.set_publisher(recorder.clone());
        let first = scopes.for_project("/work/a").await.unwrap();
        assert_eq!(scopes.for_project("/work/a").await.unwrap(), first);
        scopes.for_project("/work/b").await.unwrap();
        let syncs = recorder.0.lock().unwrap().clone();
        assert_eq!(syncs.len(), 2, "a known project does not sync again");
        let (generation, records) = &syncs[1];
        assert_eq!(*generation, 2);
        let folders: Vec<_> = records
            .iter()
            .map(|record| record.workdir.clone().unwrap())
            .collect();
        assert_eq!(folders, ["/work/a", "/work/b"]);
        assert_eq!(records[0].carriers.len(), 2);
        scopes.forget_sync().await;
        scopes.for_project("/work/a").await.unwrap();
        assert_eq!(
            recorder.0.lock().unwrap().len(),
            3,
            "a forgotten sync syncs again"
        );
    }

    #[tokio::test]
    async fn a_relative_folder_or_no_daemon_is_refused_by_name() {
        let scopes = ChildScopes::new("magic-context");
        let error = scopes.for_project("work/a").await.unwrap_err();
        assert_eq!(error.code, "child_scope_invalid_workdir");
        let error = scopes.for_project("/work/a").await.unwrap_err();
        assert_eq!(error.code, "child_scope_owner_unavailable");
    }
}
