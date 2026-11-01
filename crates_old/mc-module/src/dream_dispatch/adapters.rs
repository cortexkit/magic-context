//! Concrete bounded storage adapters. No model call runs inside these methods.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::thread::JoinHandle;
use std::time::Duration;

use mc_store::{McStore, McStoreError};
use rusqlite::Transaction;

use crate::historian_numerical_drain::{DrainMeta, DrainStore};
use crate::memory_actions::{EmbeddingEffect, EmbeddingEffectKind, MemoryEmbeddingQueue};
use crate::recomp_staging::{DurableStagingBackend, StagingRows, StagingScope};

/// Vector invalidation is the durable queue: the background drain finds a live
/// memory with no vector for its current hash and retries until publication.
pub struct EmbeddingQueue;

impl MemoryEmbeddingQueue for EmbeddingQueue {
    fn enqueue_tx(&self, tx: &Transaction<'_>, effect: &EmbeddingEffect) -> rusqlite::Result<()> {
        use mc_store::retrieval_vectors::queue as vectors;
        vectors::enqueue_tx(
            tx,
            &vectors::EmbeddingEffect {
                project_path: effect.project_path.clone(),
                session_id: effect.session_id.clone(),
                memory_id: effect.memory_id,
                kind: match effect.kind {
                    EmbeddingEffectKind::Embed => vectors::EmbeddingEffectKind::Embed,
                    EmbeddingEffectKind::Invalidate => vectors::EmbeddingEffectKind::Invalidate,
                },
                content: effect.content.clone(),
                content_hash: effect.content_hash.clone(),
                queued_at: effect.queued_at,
            },
        )
    }
}

impl DrainStore for McStore {
    type Error = McStoreError;

    fn with_immediate_transaction<T>(
        &self,
        session_id: &str,
        apply: impl FnOnce(&mut DrainMeta) -> T,
    ) -> Result<T, Self::Error> {
        self.update_drain_meta(session_id, |meta| {
            let mut local = DrainMeta {
                protected_tail_drain_window_started_at: meta.protected_tail_drain_window_started_at,
                protected_tail_drain_tokens: meta.protected_tail_drain_tokens,
                emergency_drain_active: meta.emergency_drain_active,
                historian_drain_failure_at: meta.historian_drain_failure_at,
            };
            let value = apply(&mut local);
            *meta = mc_store::background_state::DrainMeta {
                protected_tail_drain_window_started_at: local
                    .protected_tail_drain_window_started_at,
                protected_tail_drain_tokens: local.protected_tail_drain_tokens,
                emergency_drain_active: local.emergency_drain_active,
                historian_drain_failure_at: local.historian_drain_failure_at,
            };
            Ok(value)
        })
    }
}

fn convert<T: serde::de::DeserializeOwned>(value: impl serde::Serialize) -> rusqlite::Result<T> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| rusqlite::Error::InvalidQuery)
}

struct Renewal {
    scope: StagingScope,
    holder: String,
    lost: Arc<AtomicBool>,
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for Renewal {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Owns the shared compartment lease while the stager performs model work. Renewal
/// uses short transactions on a separate worker; dropping the backend stops it.
pub struct RecompBackend {
    store: Arc<McStore>,
    renewal: Option<Renewal>,
    renewal_interval: Duration,
}

impl RecompBackend {
    pub fn new(store: Arc<McStore>) -> Self {
        Self {
            store,
            renewal: None,
            renewal_interval: Duration::from_millis(
                mc_store::background_state::COMPARTMENT_LEASE_RENEWAL_MS,
            ),
        }
    }

    fn holder(&self, scope: &StagingScope) -> Result<&str, McStoreError> {
        self.renewal
            .as_ref()
            .filter(|r| r.scope == *scope && !r.lost.load(Ordering::Acquire))
            .map(|r| r.holder.as_str())
            .ok_or_else(|| {
                mc_store::single_store_domain::context_error(
                    "lease_lost",
                    "recomp lease is not held",
                )
            })
    }
}

impl DurableStagingBackend for RecompBackend {
    type Error = McStoreError;

    fn load(&mut self, scope: &StagingScope) -> Result<StagingRows, Self::Error> {
        convert(
            self.store
                .load_recomp_staging(&scope.harness, &scope.session_id)?,
        )
        .map_err(mc_store::single_store_domain::context_sql_error)
    }

    fn update<F>(&mut self, scope: &StagingScope, change: F) -> Result<(), Self::Error>
    where
        F: FnOnce(&mut StagingRows),
    {
        let holder = self.holder(scope)?;
        self.store.update_recomp_staging(
            &scope.harness,
            &scope.session_id,
            holder,
            crate::now_ms(),
            |rows| {
                let mut local = convert(&*rows)?;
                change(&mut local);
                *rows = convert(local)?;
                Ok(())
            },
        )
    }

    fn wrapup_in_progress(&mut self, scope: &StagingScope) -> Result<bool, Self::Error> {
        self.store.background_wrapup_in_progress(&scope.session_id)
    }

    fn acquire_lease(&mut self, scope: &StagingScope, holder: &str) -> Result<bool, Self::Error> {
        if self.renewal.is_some() {
            return Ok(false);
        }
        if !self
            .store
            .acquire_compartment_lease(&scope.session_id, holder, crate::now_ms())?
        {
            return Ok(false);
        }
        let store = self.store.clone();
        let session = scope.session_id.clone();
        let owned_holder = holder.to_owned();
        let lost = Arc::new(AtomicBool::new(false));
        let worker_lost = lost.clone();
        let (stop, receiver) = mpsc::channel();
        let interval = self.renewal_interval;
        let worker = match std::thread::Builder::new()
            .name("mc-recomp-lease".into())
            .spawn(move || {
                while receiver.recv_timeout(interval) == Err(mpsc::RecvTimeoutError::Timeout) {
                    if !store
                        .renew_compartment_lease(&session, &owned_holder, crate::now_ms())
                        .unwrap_or(false)
                    {
                        worker_lost.store(true, Ordering::Release);
                        break;
                    }
                }
            }) {
            Ok(worker) => worker,
            Err(error) => {
                let _ = self
                    .store
                    .release_compartment_lease(&scope.session_id, holder);
                return Err(mc_store::single_store_domain::context_error(
                    "lease_worker_failed",
                    error,
                ));
            }
        };
        self.renewal = Some(Renewal {
            scope: scope.clone(),
            holder: holder.into(),
            lost,
            stop,
            worker: Some(worker),
        });
        Ok(true)
    }

    fn owns_lease(&mut self, scope: &StagingScope, holder: &str) -> Result<bool, Self::Error> {
        if self.holder(scope).ok() != Some(holder) {
            return Ok(false);
        }
        self.store
            .owns_compartment_lease(&scope.session_id, holder, crate::now_ms())
    }

    fn release_lease(&mut self, scope: &StagingScope, holder: &str) {
        if self
            .renewal
            .as_ref()
            .is_some_and(|r| r.scope == *scope && r.holder == holder)
        {
            drop(self.renewal.take());
            let _ = self
                .store
                .release_compartment_lease(&scope.session_id, holder);
        }
    }
}

impl Drop for RecompBackend {
    fn drop(&mut self) {
        if let Some(renewal) = self.renewal.take() {
            let scope = renewal.scope.clone();
            let holder = renewal.holder.clone();
            drop(renewal);
            let _ = self
                .store
                .release_compartment_lease(&scope.session_id, &holder);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::historian_numerical_drain::{
        reserve_protected_tail_drain_tokens, rollback_protected_tail_drain_reservation,
        ReserveRequest,
    };
    use crate::recomp_staging::{CompartmentInput, RawHistory, RecompStager};

    fn fixture() -> (Arc<McStore>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
        (Arc::new(McStore::open_for_test(&descriptor).unwrap()), dir)
    }

    #[test]
    fn real_drain_adapter_reserves_refunds_and_does_nothing_when_off() {
        let (store, _dir) = fixture();
        let request = ReserveRequest {
            session_id: "ses",
            run_id: "run",
            true_raw_tokens: 100.0,
            usage_percentage: 60.0,
            usable: 10000.0,
            per_run_cap: 1000.0,
            execute_threshold_percentage: 65.0,
            now: 1000,
        };
        assert!(
            reserve_protected_tail_drain_tokens(store.as_ref(), false, request)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .with_context_read(|db| db.query_row(
                    "SELECT COUNT(*) FROM session_meta",
                    [],
                    |r| r.get::<_, i64>(0)
                ))
                .unwrap(),
            0
        );
        let result = reserve_protected_tail_drain_tokens(store.as_ref(), true, request)
            .unwrap()
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.reserved_tokens, 100.0);
        assert_eq!(
            store
                .update_drain_meta("ses", |meta| Ok(meta.protected_tail_drain_tokens))
                .unwrap(),
            100.0
        );
        rollback_protected_tail_drain_reservation(
            store.as_ref(),
            true,
            result.reservation.as_ref(),
        )
        .unwrap();
        assert_eq!(
            store
                .update_drain_meta("ses", |meta| Ok(meta.protected_tail_drain_tokens))
                .unwrap(),
            0.0
        );
    }

    #[test]
    fn embedding_adapter_invalidation_commits_and_rolls_back_with_the_source() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            &include_str!("../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
        let hash = mc_store::compute_normalized_memory_hash("new content");
        db.execute("INSERT INTO memories(id,project_path,category,content,normalized_hash,first_seen_at,created_at,updated_at,last_seen_at) VALUES (1,'project','PROJECT','new content',?1,1,1,1,1)", [&hash]).unwrap();
        db.execute(
            "INSERT INTO memory_embeddings(memory_id,embedding,model_id) VALUES (1,?1,'model')",
            [vec![0_u8; 8]],
        )
        .unwrap();
        let effect = EmbeddingEffect {
            project_path: "project".into(),
            session_id: "ses".into(),
            memory_id: 1,
            kind: EmbeddingEffectKind::Embed,
            content: Some("new content".into()),
            content_hash: hash,
            queued_at: 2,
        };
        let count = |db: &rusqlite::Connection| {
            db.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
        };
        {
            let tx = db.transaction().unwrap();
            EmbeddingQueue.enqueue_tx(&tx, &effect).unwrap();
            assert_eq!(count(&tx), 0);
        }
        assert_eq!(count(&db), 1);
        let tx = db.transaction().unwrap();
        let mut foreign = effect.clone();
        foreign.project_path = "foreign".into();
        assert!(EmbeddingQueue.enqueue_tx(&tx, &foreign).is_err());
        assert_eq!(count(&tx), 1);
        EmbeddingQueue.enqueue_tx(&tx, &effect).unwrap();
        tx.commit().unwrap();
        assert_eq!(count(&db), 0);
    }

    #[test]
    fn production_recomp_backend_stages_resumes_and_releases_without_publication() {
        let (store, dir) = fixture();
        let scope = StagingScope {
            harness: "pi".into(),
            session_id: "ses".into(),
        };
        let raw = RawHistory {
            ordinals_ready: true,
            message_count: 5,
            protected_tail_start: 4,
        };
        let mut backend = RecompBackend::new(store.clone());
        let mut stager =
            RecompStager::begin(&mut backend, scope.clone(), "rust".into(), false, raw)
                .unwrap()
                .unwrap();
        stager
            .save_validated_pass(
                vec![CompartmentInput {
                    sequence: 1,
                    start_message: 1,
                    end_message: 3,
                    start_message_id: "m1".into(),
                    end_message_id: "m3".into(),
                    start_block_index: None,
                    end_block_index: None,
                    title: "title".into(),
                    content: "body".into(),
                    p1: Some("body".into()),
                    p2: None,
                    p3: None,
                    p4: None,
                    importance: 50,
                    episode_type: None,
                }],
                vec![],
                3,
            )
            .unwrap();
        drop(stager);
        assert!(!store
            .owns_compartment_lease("ses", "rust", crate::now_ms())
            .unwrap());
        drop(backend);
        drop(store);
        let store = Arc::new(
            McStore::open_for_test(&crate::dev_descriptor_at(dir.path().to_str().unwrap()))
                .unwrap(),
        );
        let mut restarted = RecompBackend::new(store.clone());
        let stager = RecompStager::begin(&mut restarted, scope, "rust-again".into(), false, raw)
            .unwrap()
            .unwrap();
        assert!(stager.next_range().is_none());
        let ready = stager.finish().unwrap();
        assert!(ready.resumed);
        assert_eq!(ready.compartments.len(), 1);
        assert_eq!(
            store
                .with_context_read(|db| db.query_row(
                    "SELECT COUNT(*) FROM compartments",
                    [],
                    |r| r.get::<_, i64>(0)
                ))
                .unwrap(),
            0
        );
        assert!(store
            .acquire_compartment_lease("ses", "ts-wrapup", crate::now_ms())
            .unwrap());
    }

    #[test]
    fn production_recomp_backend_refuses_writes_after_lease_loss() {
        let (store, _dir) = fixture();
        let scope = StagingScope {
            harness: "pi".into(),
            session_id: "ses".into(),
        };
        let mut backend = RecompBackend::new(store.clone());
        assert!(backend.acquire_lease(&scope, "rust").unwrap());
        assert!(!store
            .acquire_compartment_lease("ses", "ts-wrapup", crate::now_ms())
            .unwrap());
        store.release_compartment_lease("ses", "rust").unwrap();
        assert!(store
            .acquire_compartment_lease("ses", "ts-wrapup", crate::now_ms())
            .unwrap());
        assert!(!backend.owns_lease(&scope, "rust").unwrap());
        assert!(backend
            .update(&scope, |rows| rows.facts.push(
                crate::recomp_staging::StagedFact {
                    category: "PROJECT".into(),
                    content: "stale".into()
                }
            ))
            .is_err());
        drop(backend);
        assert!(store
            .owns_compartment_lease("ses", "ts-wrapup", crate::now_ms())
            .unwrap());
        assert!(store
            .load_recomp_staging("pi", "ses")
            .unwrap()
            .facts
            .is_empty());
    }

    #[test]
    fn recomp_failed_renewal_marks_the_backend_lost() {
        let (store, _dir) = fixture();
        let scope = StagingScope {
            harness: "pi".into(),
            session_id: "ses".into(),
        };
        let mut backend = RecompBackend::new(store.clone());
        backend.renewal_interval = Duration::from_millis(20);
        assert!(backend.acquire_lease(&scope, "rust").unwrap());
        store.release_compartment_lease("ses", "rust").unwrap();
        assert!(store
            .acquire_compartment_lease("ses", "successor", crate::now_ms())
            .unwrap());
        // A failed renewal ends the worker. Join it rather than racing its loss flag.
        backend
            .renewal
            .as_mut()
            .unwrap()
            .worker
            .take()
            .unwrap()
            .join()
            .unwrap();
        assert!(backend.holder(&scope).is_err());
        assert!(backend.update(&scope, |rows| rows.facts.clear()).is_err());
        drop(backend);
        assert!(store
            .owns_compartment_lease("ses", "successor", crate::now_ms())
            .unwrap());
    }

    #[test]
    fn recomp_renewal_worker_extends_the_real_lease_and_stops_on_drop() {
        struct ObservedDomain {
            inner: mc_store::SqliteContextDomain,
            writes: mpsc::Sender<i64>,
        }
        impl mc_store::ContextDomain for ObservedDomain {
            fn read(
                &self,
                read: &mut dyn FnMut(&rusqlite::Connection) -> rusqlite::Result<()>,
            ) -> Result<(), McStoreError> {
                self.inner.read(read)
            }
            fn write(
                &self,
                tables: &[&str],
                write: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
            ) -> Result<(), McStoreError> {
                self.inner.write(tables, write)?;
                let mut acquired = 0;
                self.inner.read(&mut |db| {
                    acquired = db.query_row(
                        "SELECT COALESCE(MAX(acquired_at),0) FROM compartment_state_lease",
                        [],
                        |r| r.get(0),
                    )?;
                    Ok(())
                })?;
                let _ = self.writes.send(acquired);
                Ok(())
            }
        }
        let (store, dir) = fixture();
        let descriptor = crate::dev_descriptor_at(dir.path().to_str().unwrap());
        let cortexkit_store_types::StorageBackend::Sqlite { path } = descriptor.backend else {
            panic!("sqlite fixture")
        };
        let context_path = std::path::Path::new(&path)
            .parent()
            .unwrap()
            .join("context.db");
        let (writes, receiver) = mpsc::channel();
        store.install_context_domain(Arc::new(ObservedDomain {
            inner: mc_store::SqliteContextDomain::open(&context_path).unwrap(),
            writes,
        }));
        let scope = StagingScope {
            harness: "pi".into(),
            session_id: "ses".into(),
        };
        let mut backend = RecompBackend::new(store.clone());
        backend.renewal_interval = Duration::from_millis(20);
        assert!(backend.acquire_lease(&scope, "rust").unwrap());
        let acquired = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let renewed = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(renewed > acquired);
        assert!(backend.owns_lease(&scope, "rust").unwrap());
        drop(backend);
        assert!(!store
            .owns_compartment_lease("ses", "rust", crate::now_ms())
            .unwrap());
        for _ in receiver.try_iter() {}
        assert!(matches!(
            receiver.recv_timeout(Duration::from_millis(60)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
    }
}
