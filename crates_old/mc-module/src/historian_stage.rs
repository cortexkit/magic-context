//! Durable identities for historian stages. Production Rust lanes keep the
//! existing single-turn behavior: neither the host nor the Broca model runner
//! has proved that providers enforce a response schema under a replayed profile.
use crate::host_store::{HostStore, HostStoreError};
use mc_store::{HistorianDurableState, McStore};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const RUST_LIFECYCLE_ENABLED: bool = false;

pub(crate) fn lifecycle_enabled() -> bool {
    #[cfg(test)]
    if TEST_ENABLED.with(std::cell::Cell::get) {
        return true;
    }
    RUST_LIFECYCLE_ENABLED
}

#[cfg(test)]
thread_local! { static TEST_ENABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[cfg(test)]
pub(crate) struct EnabledTestLane(bool);
#[cfg(test)]
impl Drop for EnabledTestLane {
    fn drop(&mut self) {
        TEST_ENABLED.with(|enabled| enabled.set(self.0));
    }
}
#[cfg(test)]
pub(crate) fn enabled_test_lane() -> EnabledTestLane {
    EnabledTestLane(TEST_ENABLED.with(|enabled| enabled.replace(true)))
}

pub fn publication_id(
    project: &str,
    session: &str,
    fingerprint: &str,
    revert_epoch: u64,
) -> String {
    let input = json!([project, session, fingerprint, revert_epoch]).to_string();
    format!("rust-publication:{:x}", Sha256::digest(input.as_bytes()))
}

pub fn stage_key(project: &str, publication: &str, run_attempt: u64, stage: &str) -> String {
    json!([project, publication, run_attempt, stage]).to_string()
}

/// Check keys bind the decision, clause or pair being checked, revisions, inputs
/// and profile. Hash the whole key so two clauses never share a provider session
/// or accidentally reuse each other's verdict or the historian's prior messages.
pub fn check_session_id(check_key: &str) -> String {
    format!("mc-check-{:x}", Sha256::digest(check_key.as_bytes()))
}

#[derive(Debug, Clone)]
pub struct HistorianStage {
    pub project: String,
    pub publication_id: String,
    pub run_attempt: u64,
    pub stage: String,
    pub stage_key: String,
}

impl HistorianStage {
    pub fn turn_one(project: &str, session: &str, state: &HistorianDurableState) -> Self {
        let publication_id = publication_id(
            project,
            session,
            &state.chunk_fingerprint,
            state.expected_revert_epoch,
        );
        Self {
            project: project.into(),
            stage_key: stage_key(project, &publication_id, state.firing_seq, "turn_one"),
            publication_id,
            run_attempt: state.firing_seq,
            stage: "turn_one".into(),
        }
    }

    pub fn wire(&self, child: Option<&str>) -> Value {
        json!({"publication_id": self.publication_id, "run_attempt": self.run_attempt,
            "stage": self.stage, "stage_key": self.stage_key, "child_session_id": child,
            "lane": if lifecycle_enabled() { "enabled" } else { "dormant" }, "retain_child": true})
    }

    /// The module's database adapter exposes the context.db path in its status.
    /// Open it through HostStore so stage writes obey the same schema fingerprint
    /// checks as compartment writes. Bare McStore test doubles lack this adapter.
    fn host_store(store: &McStore) -> Result<Option<HostStore>, HostStoreError> {
        let status = store.context_domain_status();
        status
            .get("path")
            .and_then(Value::as_str)
            .map(|path| HostStore::open(Path::new(path)))
            .transpose()
    }

    #[allow(clippy::too_many_arguments)] // Columns persisted together before dispatch.
    pub fn persist(
        &self,
        store: &McStore,
        session: &str,
        harness: &str,
        carrier: &str,
        child: Option<&str>,
        request: &Value,
        now: i64,
    ) -> Result<(), HostStoreError> {
        if !lifecycle_enabled() {
            return Ok(());
        }
        let Some(mut host) = Self::host_store(store)? else {
            return Ok(());
        };
        host.with_domain_transaction(&["memory_publications", "memory_stage_attempts"], &mut |tx| {
            tx.execute("INSERT OR IGNORE INTO memory_publications(publication_id,project_path,source_session_id) VALUES (?1,?2,?3)",
                params![self.publication_id, self.project, session])?;
            tx.execute("INSERT OR IGNORE INTO memory_stage_attempts
                (stage_key,project_path,publication_id,run_attempt,stage,session_id,harness,child_session_id,carrier,state,request_json,started_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'in_flight',?10,?11)",
                params![self.stage_key, self.project, self.publication_id, self.run_attempt, self.stage, session, harness, child, carrier, request.to_string(), now])?;
            Ok(())
        })
    }

    pub fn child(&self, store: &McStore) -> Result<Option<String>, HostStoreError> {
        let Some(mut host) = Self::host_store(store)? else {
            return Ok(None);
        };
        let mut child = None;
        host.with_domain_transaction(&["memory_stage_attempts"], &mut |tx| {
            child = tx
                .query_row(
                    "SELECT child_session_id FROM memory_stage_attempts WHERE stage_key=?1",
                    [&self.stage_key],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten();
            Ok(())
        })?;
        Ok(child)
    }

    pub fn record_host_child(
        &self,
        store: &McStore,
        child: &str,
        reply: &Value,
    ) -> Result<(), HostStoreError> {
        if !lifecycle_enabled() {
            return Ok(());
        }
        let Some(mut host) = Self::host_store(store)? else {
            return Ok(());
        };
        host.with_domain_transaction(&["memory_stage_attempts"], &mut |tx| {
            let changed = tx.execute(
                "UPDATE memory_stage_attempts SET child_session_id=?2,reply_json=?3
                WHERE stage_key=?1 AND (child_session_id IS NULL OR child_session_id=?2)",
                params![self.stage_key, child, reply.to_string()],
            )?;
            if changed != 1 {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(())
        })
    }
}

/// Recover a dispatch that crashed before its provider acknowledgement was saved.
/// The request and key were committed first; replaying them cannot mint an attempt.
pub(crate) fn recover_broca_stage(
    store: &McStore,
    session: &str,
    state: &HistorianDurableState,
) -> Result<Option<(String, String)>, HostStoreError> {
    if !lifecycle_enabled() {
        return Ok(None);
    }
    let Some(mut host) = HistorianStage::host_store(store)? else {
        return Ok(None);
    };
    let mut record: Option<(String, String, String)> = None;
    host.with_domain_transaction(&["memory_stage_attempts"], &mut |tx| {
        record = tx.query_row("SELECT stage_key,child_session_id,request_json FROM memory_stage_attempts
            WHERE session_id=?1 AND run_attempt=?2 AND stage='turn_one' AND carrier='broca' AND state='in_flight'",
            params![session, state.firing_seq], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
        Ok(())
    })?;
    let Some((key, child, request)) = record else {
        return Ok(None);
    };
    let request: Value =
        serde_json::from_str(&request).map_err(|e| HostStoreError::OpenFailed {
            path: session.into(),
            reason: e.to_string(),
        })?;
    let body = crate::historian_producer::session_send_request(
        &key,
        request["system"].as_str().unwrap_or(""),
        request["prompt"].as_str().unwrap_or(""),
        request["model"].as_str().unwrap_or(""),
        request["variant"].as_str(),
        crate::historian_producer::HISTORIAN_MAX_OUTPUT_TOKENS,
        request["temperature"].as_f64(),
        // Stage sends are dispatched without retention; see `start_stage_with_generation`.
        crate::child_retention::ChildRetention::Nothing,
    )
    .map_err(|e| HostStoreError::OpenFailed {
        path: session.into(),
        reason: e.to_string(),
    })?;
    let body = serde_json::to_value(body).map_err(|e| HostStoreError::OpenFailed {
        path: session.into(),
        reason: e.to_string(),
    })?;
    Ok(Some((
        child.clone(),
        crate::historian_producer::stage_submission_handle(&child, &body).run_id,
    )))
}

/// After the historian durably enters Idle, no turn-one session needs retention.
/// Queued sends awaiting recovery stay AwaitingProducer and are not released here.
pub(crate) fn finish_idle_stage(
    store: &McStore,
    session: &str,
    attempt: u64,
) -> Result<(), HostStoreError> {
    if !lifecycle_enabled() {
        return Ok(());
    }
    let Some(mut host) = HistorianStage::host_store(store)? else {
        return Ok(());
    };
    host.with_domain_transaction(&["memory_stage_attempts"], &mut |tx| {
        tx.execute("UPDATE memory_stage_attempts SET state=CASE
            WHEN EXISTS (SELECT 1 FROM memory_publications p WHERE p.publication_id=memory_stage_attempts.publication_id AND p.commit_order IS NOT NULL)
            THEN 'committed' ELSE 'abandoned' END
            WHERE session_id=?1 AND run_attempt=?2 AND stage='turn_one' AND state='in_flight'",
            params![session, attempt])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_stage_retains_child_and_broca_dispatch_recovers_before_ack() {
        let _lane = enabled_test_lane();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        let descriptor = cortexkit_store_types::StorageDescriptor {
            module_id: "stage-test".into(),
            storage_namespace: mc_store::single_store_schema::STORE_NAMESPACE.into(),
            isolation: cortexkit_store_types::Isolation::Module,
            backend: cortexkit_store_types::StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        store.install_context_domain(std::sync::Arc::new(
            crate::single_store_reads::ModuleContextDomain::open(&path).unwrap(),
        ));
        let state = HistorianDurableState {
            state: mc_store::HistorianPhase::Firing,
            firing_seq: 7,
            chunk_fingerprint: "frozen-chunk".into(),
            expected_revert_epoch: 3,
            ..Default::default()
        };
        crate::historian::persist_historian_state(&store, "source", state.clone()).unwrap();
        let stage = HistorianStage::turn_one("/p", "source", &state);
        let request = json!({"system":"fixed-system","prompt":"frozen-input","model":"prov/model","temperature":0.2});
        stage
            .persist(
                &store,
                "source",
                "opencode",
                "broca",
                Some("historian-child"),
                &request,
                10,
            )
            .unwrap();
        let action = crate::historian::handle_restart_load(&store, "source", 30).unwrap();
        let crate::historian::RestartAction::ReattachProducer {
            producer_session_id,
            producer_run_id,
            firing_seq,
            ..
        } = action
        else {
            panic!("dispatch was abandoned");
        };
        assert_eq!(firing_seq, 7);
        assert_eq!(producer_session_id, "historian-child");
        let record: Value =
            serde_json::from_str(producer_run_id.strip_prefix("mc-broca-stage:").unwrap()).unwrap();
        assert_eq!(record["request"]["params"]["send_id"], stage.stage_key);
        assert_eq!(record["request"]["params"]["system"], "fixed-system");
        assert_eq!(record["request"]["params"]["prompt"], "frozen-input");
        let host_state = HistorianDurableState {
            firing_seq: 8,
            ..state
        };
        let host = HistorianStage::turn_one("/p", "source", &host_state);
        host.persist(
            &store,
            "source",
            "opencode",
            "rust_host",
            None,
            &request,
            11,
        )
        .unwrap();
        host.record_host_child(
            &store,
            "host-child",
            &json!({"stage_key":host.stage_key,"child_session_id":"host-child"}),
        )
        .unwrap();
        let recovered = HistorianStage::turn_one("/p", "source", &host_state);
        assert_eq!(
            recovered.child(&store).unwrap().as_deref(),
            Some("host-child")
        );
        assert_eq!(
            recovered.wire(recovered.child(&store).unwrap().as_deref())["child_session_id"],
            "host-child"
        );
        assert!(recovered
            .record_host_child(&store, "another-child", &json!({}))
            .is_err());
        let conn = rusqlite::Connection::open(&path).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM memory_stage_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 2);
        crate::historian::persist_historian_state(
            &store,
            "source",
            HistorianDurableState {
                firing_seq: 8,
                ..Default::default()
            },
        )
        .unwrap();
        let terminal: String = conn
            .query_row(
                "SELECT state FROM memory_stage_attempts WHERE stage_key=?1",
                [&host.stage_key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(terminal, "abandoned");
    }

    #[test]
    fn stage_and_check_identities_are_operand_specific_and_recoverable() {
        let first = stage_key("/p", "publication", 4, "turn_one");
        assert_eq!(first, "[\"/p\",\"publication\",4,\"turn_one\"]");
        assert_eq!(first, stage_key("/p", "publication", 4, "turn_one"));
        assert_ne!(first, stage_key("/p", "publication", 4, "turn_two"));
        assert_ne!(first, stage_key("/p", "publication", 5, "turn_one"));
        let a = check_session_id("decision:revision=1:support:clause=1:input=A:profile=X");
        assert_eq!(
            a,
            check_session_id("decision:revision=1:support:clause=1:input=A:profile=X")
        );
        for key in [
            "decision:revision=1:support:clause=2:input=A:profile=X",
            "decision:revision=2:support:clause=1:input=A:profile=X",
            "decision:revision=1:support:clause=1:input=B:profile=X",
            "decision:revision=1:support:clause=1:input=A:profile=Y",
        ] {
            assert_ne!(a, check_session_id(key));
        }
        const {
            assert!(!RUST_LIFECYCLE_ENABLED);
        }
    }
}
