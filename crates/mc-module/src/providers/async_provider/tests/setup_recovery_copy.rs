//! Opt-in recovery rehearsal. Inputs are stopped-store copies, never live stores.
use super::*;

#[tokio::test]
#[ignore = "requires MC_RECOVERY_COPY_DIR and MC_RECOVERY_FIXTURE_DIR with stopped-store copies"]
async fn replay_cut_recovery_on_store_copy() {
    let copies =
        std::path::PathBuf::from(std::env::var_os("MC_RECOVERY_COPY_DIR").expect("copy directory"));
    let fixtures = std::path::PathBuf::from(
        std::env::var_os("MC_RECOVERY_FIXTURE_DIR").expect("fixture directory"),
    );
    replay(&copies, &fixtures).await;
}

pub(super) async fn replay(copies: &Path, fixtures: &Path) {
    let setup: Value =
        serde_json::from_slice(&std::fs::read(fixtures.join("setup.json")).unwrap()).unwrap();
    let setup_request: compact::setup::SetupRequest = decode(&setup["request"]).unwrap();
    let runner_module = setup["runner_module"].as_str().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    for name in ["store.db", "context.db"] {
        let source = copies.join(name).canonicalize().unwrap();
        let path = source.to_string_lossy();
        assert!(
            !path.contains("/.local/share/cortexkit/magic-context/")
                && !path.contains("/.local/share/opencode/"),
            "live stores are forbidden"
        );
        assert!(
            !copies.join(format!("{name}-wal")).exists(),
            "copy must be checkpointed"
        );
        std::fs::copy(source, scratch.path().join(name)).unwrap();
    }
    // The database copy retains its writer fence, but its new directory has
    // no lease history. Acquire normal lease tokens up to that fence before
    // opening the provider; never lower the fence or edit the copied record.
    let conn = rusqlite::Connection::open(scratch.path().join("store.db")).unwrap();
    let fence: u64 = conn
        .query_row("SELECT epoch FROM cortexkit_fence WHERE id=0", [], |row| {
            row.get(0)
        })
        .unwrap();
    drop(conn);
    assert!(
        fence <= 10_000,
        "export lease metadata for a store with a higher writer fence"
    );
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: scratch.path().join("store.db").to_string_lossy().into(),
        },
    };
    loop {
        let lease = cortexkit_store::open_sqlite(&descriptor).unwrap();
        let epoch = lease.epoch();
        drop(lease);
        if epoch >= fence {
            break;
        }
    }
    let request = serde_json::to_value(&setup_request).unwrap();
    let rig = Rig::without_setup(
        scratch.path(),
        runner_module,
        (&setup_request.harness, &setup_request.session),
        (&setup_request.harness, &setup_request.session),
        |_| {},
    )
    .await;
    let head: Value =
        serde_json::from_slice(&std::fs::read(fixtures.join("session.head.json")).unwrap())
            .unwrap();
    *rig.runner.head_override.lock().unwrap() = Some(head.clone());
    *rig.runner.lineage.lock().unwrap() = head["lineage_id"].as_str().unwrap().into();
    let pages = std::fs::read_to_string(fixtures.join("session.read.jsonl")).unwrap();
    let mut entries = BTreeMap::new();
    for line in pages.lines().filter(|line| !line.trim().is_empty()) {
        let page: cortexkit_role_llm_runner::read::ReadPage = serde_json::from_str(line).unwrap();
        assert_eq!(page.lineage_id.as_deref(), head["lineage_id"].as_str());
        for entry in page.messages {
            assert!(entries.insert(entry.ordinal, entry).is_none());
        }
    }
    let first = head["first_ordinal"].as_u64().unwrap();
    assert_eq!(entries.first_key_value().unwrap().0, &first);
    let last = entries.last_key_value().unwrap().1.clone();
    *rig.runner.entries.lock().unwrap() = entries.into_values().collect();
    let started = std::time::Instant::now();
    let answer = rig.op("compaction.setup", request).await;
    let size = serde_json::to_vec(&answer).unwrap().len() + 21;
    println!(
        "Setup answer={} frame_bytes={} due={} elapsed_ms={}",
        answer["answer"],
        size,
        answer["view_due"]["version"],
        started.elapsed().as_millis()
    );
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert!(size <= 4 * 1024 * 1024);
    let version = answer["view_due"]["version"]
        .as_u64()
        .expect("recovery must name a due view");
    let fetched = rig.get(version).await;
    assert_eq!(fetched.digest, answer["view_due"]["digest"]);
    assert_eq!(
        fetched.lineage_id,
        setup_request.lineage_id.as_deref().unwrap()
    );
    let seq = rig.state().seq + 1;
    let parent = setup_request.descends_from.as_ref().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        seq,
        setup_request.lineage_id.as_deref().unwrap(),
        last.ordinal,
        served_digest(&last).unwrap(),
        0,
        "fixture",
    )
    .with_applied_view_version(version)
    .with_first_ordinal(first)
    .with_descends_from(notice::NoticeDescent::new(
        &parent.lineage_id,
        parent.through_ordinal,
        head["cut"]["digest"].as_str().unwrap(),
    ));
    let headers = notice.to_headers();
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", seq),
        digest: notice.digest().parse().unwrap(),
        headers,
    };
    rig.h.advance_compaction("fixture", &message).await.unwrap();
    let state = rig.state();
    let adopted = state.lineage == setup_request.lineage_id
        && state.applied == Some(version)
        && state.completed_seq == seq;
    println!(
        "next_notice_adopted={adopted} generation={}",
        state.generation
    );
    assert!(adopted);
}

pub(super) async fn rehearse(rig: &Rig, request: Value) {
    let copies = tempfile::tempdir().unwrap();
    let fixtures = tempfile::tempdir().unwrap();
    let state = rig.state();
    let origin = state.newest_published_cut().unwrap().first_ordinal;
    let entries = rig.runner.entries.lock().unwrap().clone();
    let cut = entries
        .iter()
        .find(|entry| entry.ordinal == origin - 1)
        .unwrap();
    let head = json!({"lineage_id": request["lineage_id"], "first_ordinal": origin,
        "cut":{"mid":cut.mid,"digest":served_digest(cut).unwrap(),"written_at":1}});
    std::fs::write(
        fixtures.path().join("setup.json"),
        json!({"request":request,
        "runner_module":rig.module})
        .to_string(),
    )
    .unwrap();
    std::fs::write(fixtures.path().join("session.head.json"), head.to_string()).unwrap();
    let page = json!({"lineage_id":head["lineage_id"], "messages":entries.into_iter()
        .filter(|entry| entry.ordinal >= origin).collect::<Vec<_>>()});
    std::fs::write(fixtures.path().join("session.read.jsonl"), page.to_string()).unwrap();
    for name in ["store.db", "context.db"] {
        let conn = rusqlite::Connection::open(state.project().join(name)).unwrap();
        conn.execute(
            "VACUUM INTO ?1",
            [copies.path().join(name).to_string_lossy().as_ref()],
        )
        .unwrap();
    }
    replay(copies.path(), fixtures.path()).await;
}
