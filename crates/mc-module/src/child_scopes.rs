//! Module-owned project scopes shared by historian, classifier and dream children.

use std::{
    collections::BTreeMap,
    fmt,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use subc_client_rs::{async_trait, ModuleHandle, ScopeCallError};
use subc_protocol::{
    scope::{ScopeCarrier, ScopeKind, ScopeRecord, ScopeRecordOutcome, ScopeSelector},
    Principal,
};

#[derive(Debug, Clone)]
pub(crate) struct ScopeError {
    pub code: String,
    pub message: String,
}

impl fmt::Display for ScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[async_trait]
pub(crate) trait ScopePublisher: Send + Sync {
    async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError>;
}

struct ModulePublisher(ModuleHandle);

#[async_trait]
impl ScopePublisher for ModulePublisher {
    async fn sync(&self, generation: u64, scopes: Vec<ScopeRecord>) -> Result<(), ScopeError> {
        let expected = scopes
            .iter()
            .map(|scope| (scope.scope_ref.clone(), scope.scope_epoch))
            .collect::<Vec<_>>();
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
                message: "scope.sync returned a different generation or record count".into(),
            });
        }
        for (result, (scope_ref, epoch)) in reply.results.into_iter().zip(expected) {
            if result.outcome == ScopeRecordOutcome::Refused {
                return Err(ScopeError {
                    code: result.code.unwrap_or_else(|| "child_scope_refused".into()),
                    message: result
                        .message
                        .unwrap_or_else(|| "child scope refused".into()),
                });
            }
            if result.scope_ref != scope_ref || result.scope_epoch != epoch {
                return Err(ScopeError {
                    code: "child_scope_sync_protocol".into(),
                    message: "scope.sync returned a different scope identity".into(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Default)]
struct State {
    generation: u64,
    connection_epoch: u64,
    synced: bool,
    records: BTreeMap<String, ScopeRecord>,
}

pub struct ChildScopes {
    module_id: String,
    incarnation: String,
    publisher: Mutex<Option<Arc<dyn ScopePublisher>>>,
    state: tokio::sync::Mutex<State>,
    connection_epoch: AtomicU64,
}

impl ChildScopes {
    pub fn new(module_id: impl Into<String>) -> Self {
        let incarnation = crate::sha256_hex(
            &subc_transport::generate_daemon_id().expect("secure child scope incarnation"),
        )[..32]
            .to_string();
        Self {
            module_id: module_id.into(),
            incarnation,
            publisher: Mutex::new(None),
            state: tokio::sync::Mutex::new(State::default()),
            connection_epoch: AtomicU64::new(0),
        }
    }

    pub fn install(&self, handle: ModuleHandle) {
        *self.publisher.lock().expect("child scope publisher") =
            Some(Arc::new(ModulePublisher(handle)));
    }

    pub(crate) fn reconnected(&self) {
        self.connection_epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub(crate) async fn for_project(
        &self,
        project_root: &Path,
    ) -> Result<ScopeSelector, ScopeError> {
        let workdir = project_root
            .to_str()
            .filter(|_| project_root.is_absolute())
            .ok_or_else(|| ScopeError {
                code: "child_scope_invalid_workdir".into(),
                message: "child project must be an absolute UTF-8 directory".into(),
            })?;
        let mut state = self.state.lock().await;
        let connection_epoch = self.connection_epoch.load(Ordering::Acquire);
        if state.connection_epoch != connection_epoch {
            state.synced = false;
            state.connection_epoch = connection_epoch;
        }
        let scope_ref = project_scope_ref(&self.incarnation, workdir);
        let selector = ScopeSelector::new(
            Principal::Reserved {
                module_id: self.module_id.clone(),
            },
            &scope_ref,
            Some(1),
        );
        if state.synced && state.records.contains_key(workdir) {
            return Ok(selector);
        }
        let publisher = self
            .publisher
            .lock()
            .expect("child scope publisher")
            .clone()
            .ok_or_else(|| ScopeError {
                code: "child_scope_owner_unavailable".into(),
                message: "module serving handle is not installed".into(),
            })?;
        let mut records = state.records.clone();
        records.entry(workdir.to_owned()).or_insert_with(|| {
            ScopeRecord::new(scope_ref, 1, ScopeKind::Ephemeral)
                // This replaces the folder previously sent as the child bind's
                // project_root. Preserve its spelling without normalization.
                .with_workdir(Some(workdir.to_owned()))
                .with_carriers(
                    ["thalamus-harness", "broca"]
                        .map(|module_id| {
                            ScopeCarrier::new(Principal::Reserved {
                                module_id: module_id.into(),
                            })
                        })
                        .into(),
                )
        });
        // scope.sync replaces the owner's whole set, so retain every earlier
        // project's record when adding one. Repeated children do not sync again.
        state.generation = state.generation.checked_add(1).ok_or_else(|| ScopeError {
            code: "child_scope_generation_exhausted".into(),
            message: "scope generation exhausted".into(),
        })?;
        state.synced = false;
        // Keep the intended snapshot if its acknowledgement is lost. A later
        // sync for another project must not accidentally end this scope.
        state.records = records;
        publisher
            .sync(state.generation, state.records.values().cloned().collect())
            .await?;
        if self.connection_epoch.load(Ordering::Acquire) != connection_epoch {
            return Err(ScopeError {
                code: "child_scope_connection_changed".into(),
                message: "module reconnected during scope.sync".into(),
            });
        }
        state.synced = true;
        Ok(selector)
    }

    #[cfg(test)]
    pub(crate) fn with_publisher(module_id: &str, publisher: Arc<dyn ScopePublisher>) -> Self {
        Self {
            module_id: module_id.into(),
            incarnation: "test-owner".into(),
            publisher: Mutex::new(Some(publisher)),
            state: tokio::sync::Mutex::new(State::default()),
            connection_epoch: AtomicU64::new(0),
        }
    }
}

fn project_scope_ref(incarnation: &str, workdir: &str) -> String {
    // A fresh owner process must not reuse a scope reference that an earlier
    // process's full snapshot ended. Folder identity remains unchanged.
    format!(
        "mc-child-project-{incarnation}-{}",
        crate::sha256_hex(workdir.as_bytes())
    )
}

#[cfg(test)]
pub(crate) fn test_selector(project: &Path) -> ScopeSelector {
    ScopeSelector::new(
        Principal::Reserved {
            module_id: crate::DEFAULT_MODULE_ID.into(),
        },
        project_scope_ref("test-owner", project.to_str().unwrap()),
        Some(1),
    )
}

#[cfg(test)]
pub(crate) fn test_service() -> Arc<ChildScopes> {
    struct Accept;
    #[async_trait]
    impl ScopePublisher for Accept {
        async fn sync(&self, _: u64, _: Vec<ScopeRecord>) -> Result<(), ScopeError> {
            Ok(())
        }
    }
    Arc::new(ChildScopes::with_publisher(
        crate::DEFAULT_MODULE_ID,
        Arc::new(Accept),
    ))
}

#[cfg(test)]
mod tests;

#[cfg(all(test, target_os = "linux"))]
mod supervised_tests;
