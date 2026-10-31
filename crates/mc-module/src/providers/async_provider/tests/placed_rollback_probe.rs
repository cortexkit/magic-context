//! Exercise legacy inline-record decoding, absent-record Setup and global view
//! announcements in commit d76e06856688678b3d17e41d8a270256204d7f5c.
//! The archived-commit harness uses its real decoder and announcement loop; no
//! decoder or persisted-record fixture is copied into the current test binary.
use super::*;
use std::sync::atomic::Ordering;

const MODULE: &str = "thalamus-harness";
const FIRST: &str = "rollback-migrated";
const SECOND: &str = "rollback-untouched";

#[derive(Default)]
struct Seen(Mutex<Vec<String>>);
#[async_trait]
impl Publisher for Seen {
    async fn publish(&self, ready: &notice::ViewReady) -> Result<(), HandlerOutcome> {
        self.0.lock().unwrap().push(ready.session_ref.clone());
        Ok(())
    }
}

fn root() -> std::path::PathBuf {
    let path = std::path::PathBuf::from(std::env::var("MC_ROLLBACK_DIR").unwrap());
    std::fs::create_dir_all(&path).unwrap();
    path
}
fn open(path: &Path) -> Arc<McStore> {
    Arc::new(
        McStore::open_for_test(&StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: path.join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap(),
    )
}
async fn settle(rig: &Rig) {
    tokio::time::timeout(Duration::from_secs(30), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(Ordering::SeqCst)
            > 0
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
#[ignore]
async fn placed_rollback_seed() {
    let path = root();
    let mut references = Vec::new();
    let (mut rig, answer) = Rig::try_setup_with_model(
        &path,
        MODULE,
        ("runner", FIRST),
        ("opencode", FIRST),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |_| {},
    )
    .await;
    assert_eq!(answer["answer"], "ready");
    for (index, session) in [FIRST, SECOND].into_iter().enumerate() {
        if index > 0 {
            rig.bind_provider(7, MODULE, "runner", session);
            rig.reference = runner_session_ref(MODULE, "opencode", session);
            rig.runner.entries.lock().unwrap().clear();
            let answer = rig
                .op("compaction.setup", setup_request(session, "second-seed"))
                .await;
            assert_eq!(answer["answer"], "ready", "{answer}");
        }
        rig.fill(40);
        let seq = index as u64 * 2 + 1;
        rig.notice(seq, 1000, None).await;
        settle(&rig).await;
        if index == 0 {
            rig.history(20, "rollback fixture history");
        } else {
            rig.queue(&[103]).await;
            rig.ride("ttl_expired").await;
        }
        rig.notice(seq + 1, 1000, None).await;
        settle(&rig).await;
        assert!(rig.newest().is_some());
        references.push(rig.reference.clone());
    }
    rig.task.abort();
    let _ = (&mut rig.task).await;
    let store = Arc::clone(rig.h.store.get().unwrap());
    for reference in &references {
        let (views, high) = store.load_async_compaction_views(reference).unwrap();
        let views = views
            .into_iter()
            .map(|(v, raw, engine, _)| (v, raw, engine, false))
            .collect::<Vec<_>>();
        store
            .adopt_async_compaction_views(reference, &views, high)
            .unwrap();
    }
    std::fs::write(
        path.join("references.json"),
        serde_json::to_vec(&references).unwrap(),
    )
    .unwrap();
    eprintln!(
        "PLACED_SEED references={references:?} pending={}",
        store.pending_async_compaction_views().unwrap().len()
    );
}

fn handler(
    path: &Path,
    store: Arc<McStore>,
    seen: Arc<Seen>,
) -> (McHandler, SessionBinding, Arc<Runner>) {
    let mut h = McHandler::new();
    h.producer_factory =
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(path).factory();
    h.store.set(store).ok().unwrap();
    let runner = Arc::new(Runner {
        module: MODULE.into(),
        lineage: Mutex::new("L".into()),
        ..Default::default()
    });
    h.provider_runner = runner.clone();
    h.session_resolver = Arc::new(CountingResolver::default());
    let config = McModuleConfig {
        inject_docs: false,
        protected_tokens_user: Some(0),
        protected_tools: BTreeMap::new(),
        ..Default::default()
    };
    h.fixed_config = Some(config.clone());
    let binding = SessionBinding {
        principal: Some(subc_protocol::Principal::Reserved {
            module_id: MODULE.into(),
        }),
        scope: None,
        project_root: path.into(),
        harness: "runner".into(),
        session: FIRST.into(),
        model_key: None,
        config,
        history_budget_tokens: 4000.0,
    };
    h.bind_route(7, binding.clone());
    *h.provider_store.async_runtime.publisher.lock().unwrap() = Some(seen);
    (h, binding, runner)
}

#[tokio::test]
#[ignore]
async fn placed_without_downgrade_refuses_only_migrated_session() {
    let path = root();
    let references: Vec<String> =
        serde_json::from_slice(&std::fs::read(path.join("references.json")).unwrap()).unwrap();
    let store = open(&path);
    assert!(
        load_head(&store, &references[0]).unwrap().is_none(),
        "new layout leaked into old load_head"
    );
    let healthy = load_head(&store, &references[1]).unwrap().unwrap();
    let before = serde_json::to_value(&healthy).unwrap();
    let raw = store
        .load_async_compaction(&references[1])
        .unwrap()
        .unwrap();
    let mut revision: Value = serde_json::from_str(&raw).unwrap();
    revision["input_revision"] = json!(42);
    let conn = rusqlite::Connection::open(path.join("store.db")).unwrap();
    conn.execute(
        "UPDATE mc_async_compaction SET state_json=?1 WHERE session_ref=?2",
        rusqlite::params![revision.to_string(), references[1]],
    )
    .unwrap();
    let decoded = load_head(&store, &references[1]).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap(),
        before,
        "optional revision changed old decoder output"
    );
    let seen = Arc::new(Seen::default());
    let (h, binding, _) = handler(&path, Arc::clone(&store), Arc::clone(&seen));
    h.announce_async_views().await.unwrap();
    assert!(!seen.0.lock().unwrap().is_empty());
    assert!(seen
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|reference| reference == &references[1]));
    eprintln!(
        "PLACED_ANNOUNCEMENTS migrated_absent=true healthy_announced={:?}",
        seen.0.lock().unwrap()
    );
    let request = setup_request(FIRST, "fresh-after-rollback");
    let error = h.async_setup(7, &binding, &request).await.unwrap_err();
    assert!(
        matches!(error, HandlerOutcome::Error { ref code, .. } if code == "transient"),
        "{error:?}"
    );
    let mut healthy_binding = binding;
    healthy_binding.session = SECOND.into();
    h.bind_route(7, healthy_binding.clone());
    let answer: Value = serde_json::from_slice(
        &h.async_setup(
            7,
            &healthy_binding,
            &setup_request(SECOND, "healthy-after-rollback"),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(answer["answer"], "ready", "{answer}");
    h.announce_async_views().await.unwrap();
    assert!(seen
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|reference| reference == &references[1]));
    eprintln!("PLACED_WITHOUT_DOWNGRADE affected_transient=true healthy_setup=true healthy_announcements=true");
}

#[tokio::test]
#[ignore]
async fn placed_after_downgrade_preserves_setup_and_first_notice() {
    let path = root();
    let references: Vec<String> =
        serde_json::from_slice(&std::fs::read(path.join("references.json")).unwrap()).unwrap();
    let store = open(&path);
    for (reference, session) in references.iter().zip([FIRST, SECOND]) {
        let before = load(&store, reference).unwrap().unwrap();
        let history = store.load_compartments(&before.namespace()).unwrap();
        assert_eq!(history.is_empty(), session == SECOND);
        let (h, mut binding, runner) =
            handler(&path, Arc::clone(&store), Arc::new(Seen::default()));
        binding.session = session.into();
        h.bind_route(7, binding.clone());
        *runner.entries.lock().unwrap() = before
            .entries
            .values()
            .map(|entry| entry.read().unwrap())
            .collect();
        *runner.lineage.lock().unwrap() = before.lineage.clone().unwrap();
        let answer: Value = serde_json::from_slice(
            &h.async_setup(7, &binding, &setup_request(session, "after-downgrade"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(answer["answer"], "ready");
        assert_eq!(answer["initial"], before.initial["initial"]);
        let after_setup = load(&store, reference).unwrap().unwrap();
        assert_eq!(
            after_setup.engine.rebuild_epoch, before.engine.rebuild_epoch,
            "upgrade/downgrade must not rebuild a matching engine"
        );
        assert_eq!(after_setup.generation, before.generation);
        let last = runner.entries.lock().unwrap().last().cloned().unwrap();
        let seq = before.seq + 1;
        let notice = notice::AdvanceNotice::new(
            reference,
            seq,
            runner.lineage.lock().unwrap().clone(),
            last.ordinal,
            contract::digest::content_digest(&last.message),
            1_000,
            "fixture",
        )
        .with_window(100_000);
        let message = cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", MODULE, notice::ADVANCED_EVENT),
            id: bus_id(reference, "advanced", seq),
            digest: notice.digest().parse().unwrap(),
            headers: notice.to_headers(),
        };
        h.advance_compaction("fixture", &message).await.unwrap();
        let after = load(&store, reference).unwrap().unwrap();
        assert_eq!(after.completed_seq, seq);
        assert_eq!(after.engine.rebuild_epoch, before.engine.rebuild_epoch);
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.entries.len(), before.entries.len());
        assert_eq!(
            store.load_compartments(&after.namespace()).unwrap(),
            history
        );
    }
    eprintln!("PLACED_DOWNGRADED sessions=2 summarized=1 setup_preserved=true first_notice=true");
}
