//! One scope-sync authority for the registered module connection. Snapshots are
//! serialized so ending one run can never accidentally end another live run.

use std::collections::BTreeMap;
use std::sync::Mutex;

use subc_client_rs::{ModuleHandle, ScopeCallError};
use subc_protocol::scope::{ScopeRecord, ScopeRecordOutcome};

use super::wire::{WireRefusal, SCOPE_UNSUPPORTED};

struct State {
    handle: Option<ModuleHandle>,
    generation: u64,
    live: BTreeMap<String, ScopeRecord>,
}

pub(super) struct Scopes {
    state: tokio::sync::Mutex<State>,
    support: Mutex<Result<(), WireRefusal>>,
    refused_folders: Mutex<BTreeMap<String, WireRefusal>>,
}

fn refusal(code: &str, detail: impl Into<String>) -> WireRefusal {
    WireRefusal {
        code: format!("mc_dream_{code}"),
        detail: detail.into(),
    }
}

fn call_error(error: ScopeCallError) -> WireRefusal {
    refusal(
        error.code().unwrap_or("scope_sync_failed"),
        error.to_string(),
    )
}

impl Default for Scopes {
    fn default() -> Self {
        Self {
            state: tokio::sync::Mutex::new(State {
                handle: None,
                generation: 0,
                live: BTreeMap::new(),
            }),
            support: Mutex::new(Err(WireRefusal {
                code: SCOPE_UNSUPPORTED.into(),
                detail: "the registered scope-sync connection is not ready".into(),
            })),
            refused_folders: Mutex::default(),
        }
    }
}

impl Scopes {
    pub async fn initialize(&self, handle: ModuleHandle) -> Result<(), WireRefusal> {
        let mut state = self.state.lock().await;
        if state.handle.is_some() {
            return Err(refusal(
                "scope_authority_already_set",
                "scope authority is process-wide",
            ));
        }
        let result = if !handle.daemon_supports("scope-workdir/v1") {
            Err(refusal(
                "scope_unsupported",
                "daemon does not declare scope-workdir/v1",
            ))
        } else {
            handle
                .scope_sync(1, Vec::new())
                .await
                .map(|_| ())
                .map_err(call_error)
        };
        state.generation = 1;
        state.handle = Some(handle);
        *self.support.lock().expect("scope support") = result.clone();
        result
    }

    pub fn support(&self) -> Result<(), WireRefusal> {
        self.support.lock().expect("scope support").clone()
    }

    pub fn support_for(&self, workdir: &str) -> Result<(), WireRefusal> {
        self.support()?;
        self.refused_folders
            .lock()
            .expect("refused scope folders")
            .get(workdir)
            .cloned()
            .map_or(Ok(()), Err)
    }

    pub async fn update(&self, record: &ScopeRecord, end: bool) -> Result<(), WireRefusal> {
        if !end {
            self.support_for(record.workdir.as_deref().unwrap_or_default())?;
        }
        let mut state = self.state.lock().await;
        let handle = state
            .handle
            .clone()
            .ok_or_else(|| refusal("not_registered", "no module handle"))?;
        let mut next = state.live.clone();
        if end {
            next.remove(&record.scope_ref);
        } else {
            next.insert(record.scope_ref.clone(), record.clone());
        }
        state.generation += 1;
        // A full snapshot also recovers an earlier call whose reply was lost.
        let result = handle
            .scope_sync(state.generation, next.values().cloned().collect())
            .await;
        match result {
            Ok(reply) => {
                let mut current_refusal = None;
                for rejected in reply
                    .results
                    .iter()
                    .filter(|r| r.outcome == ScopeRecordOutcome::Refused)
                {
                    let error = refusal(
                        rejected.code.as_deref().unwrap_or("scope_refused"),
                        rejected.message.clone().unwrap_or_default(),
                    );
                    let folder = next
                        .get(&rejected.scope_ref)
                        .and_then(|r| r.workdir.clone())
                        .unwrap_or_default();
                    self.refused_folders
                        .lock()
                        .expect("refused scope folders")
                        .insert(folder, error.clone());
                    if rejected.scope_ref == record.scope_ref {
                        current_refusal = Some(error);
                    }
                    // A refused upsert leaves an older live record unchanged.
                    if let Some(previous) = state.live.get(&rejected.scope_ref) {
                        next.insert(rejected.scope_ref.clone(), previous.clone());
                    } else {
                        next.remove(&rejected.scope_ref);
                    }
                }
                state.live = next;
                current_refusal.map_or(Ok(()), Err)
            }
            Err(error) => {
                let error = call_error(error);
                *self.support.lock().expect("scope support") = Err(error.clone());
                Err(error)
            }
        }
    }
}
