//! A moved standalone OpenCode 1 session, set up and read by ck-mc's real async
//! lane against a fake runner that serves the session the way THALAMUS's
//! OpenCode 1 runner does: the whole session from its first message, without the
//! compaction marker pair, with tags only on counted parts after the cut,
//! numbered upward from the marker's checkpoint.
use super::*;
use crate::offline_move::{self, tests as fixture};

const MODULE: &str = "thalamus-harness";

pub(super) fn apply_certified_move(paths: &offline_move::StorePaths) {
    let session = fixture::fixture_session();
    let plan = offline_move::plan(paths, &session).unwrap();
    let vector: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("message-checkpoint.json").unwrap(),
    )
    .unwrap();
    let mut head = vector["worked_head_cut"]["head_cut"].clone();
    head["mid"] = json!(plan.p);
    let certificate = paths.store_db.parent().unwrap().join("head-cut.json");
    std::fs::write(
        &certificate,
        json!({"message_count":plan.message_count,"head_cut":head}).to_string(),
    )
    .unwrap();
    offline_move::run_with_head_cut(paths, &session, &certificate, &fixture::NoHolders, None)
        .unwrap();
}

pub(super) fn newest_marker_checkpoint(
    path: &Path,
    session: &str,
) -> Option<tags::MarkerCheckpoint> {
    let conn = rusqlite::Connection::open(path).unwrap();
    let mut query = conn
        .prepare(
            "SELECT part.data FROM part JOIN message ON message.id=part.message_id
         WHERE message.session_id=?1
         ORDER BY message.time_created DESC, message.id DESC, part.id DESC",
        )
        .unwrap();
    let rows = query
        .query_map([session], |row| row.get::<_, String>(0))
        .unwrap();
    let checkpoint = rows
        .filter_map(|raw| {
            let data: Value = serde_json::from_str(&raw.unwrap()).ok()?;
            let key: tags::MarkerCheckpoint =
                serde_json::from_value(data["cortexkit"].clone()).ok()?;
            (key.session == session && key.message_count.is_some() && key.head_cut.is_some())
                .then_some(key)
        })
        .next();
    checkpoint
}

/// The session as the runner reads it from `opencode.db`.
pub(super) fn served_entries(opencode_db: &Path, session: &str) -> Vec<ReadMessage> {
    let conn = rusqlite::Connection::open(opencode_db).unwrap();
    let messages = conn
        .prepare("SELECT id, data FROM message WHERE session_id=?1 ORDER BY time_created, id")
        .unwrap()
        .query_map([session], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    let parts_of = |mid: &str| {
        conn.prepare("SELECT id, data FROM part WHERE message_id=?1 ORDER BY id")
            .unwrap()
            .query_map([mid], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    // The runner numbers from the checkpoint key on the marker in effect.
    let mut cut = None;
    let mut next = 0;
    for (mid, _) in &messages {
        for (_, data) in parts_of(mid) {
            let data: Value = serde_json::from_str(&data).unwrap();
            if data["type"] == "compaction" {
                cut = Some(mid.clone());
                next = data["cortexkit"]["tag_checkpoint"].as_u64().unwrap_or(0);
            }
        }
    }
    let cut = cut.expect("a compaction marker");
    let mut after_cut = false;
    let mut served = Vec::new();
    for (mid, data) in messages {
        let stored_parts = parts_of(&mid);
        let part_data: Vec<Value> = stored_parts
            .iter()
            .map(|(_, data)| serde_json::from_str(data).unwrap())
            .collect();
        let info: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        // SQLite's numeric comparison also treats a summary value of 1.0 as 1.
        let numeric_finished = info["summary"].as_f64() == Some(1.0) && info["finish"] == "stop";
        if numeric_finished
            || !tags::opencode1_message_counts_with_parts(
                &data,
                part_data
                    .iter()
                    .map(|part| part["type"].as_str().unwrap_or_default()),
            )
        {
            continue;
        }
        after_cut |= mid == cut;
        let mut parts = Vec::new();
        let mut rows = Vec::new();
        for (id, data) in stored_parts {
            let mut part: Value = serde_json::from_str(&data).unwrap();
            if part["type"] == "compaction" {
                continue;
            }
            let counted = part["type"] == "text"
                || (part["type"] == "tool" && part["state"]["status"] == "completed");
            if after_cut && counted {
                next += 1;
                rows.push(tags::PartTag::tagged(id.clone(), format!("§{next}§")));
            } else {
                rows.push(tags::PartTag::untagged(id.clone()));
            }
            part["id"] = json!(id);
            part["messageID"] = json!(mid);
            part["sessionID"] = json!(session);
            parts.push(part);
        }
        let mut info = info;
        info["id"] = json!(mid);
        info["sessionID"] = json!(session);
        let ordinal = served.len() as u64;
        served.push(
            ReadMessage::new(ordinal, mid.clone(), json!({"info": info, "parts": parts}))
                .with_tags(rows),
        );
    }
    served
}

pub(super) async fn moved_rig(dir: &Path, run_move: bool) -> (Rig, Value) {
    let session = fixture::fixture_session();
    // The move's apply step refuses with `source_changed` unless the marker is
    // on the selected cut, so the fixture stores put it there before each move.
    let paths = fixture::write_moved_session_stores(dir);
    // One standalone chunk embedding, which the import copies instead of
    // computing it again.
    rusqlite::Connection::open(&paths.context_db)
        .unwrap()
        .execute(
            "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
             SELECT id,session_id,'fixture','opencode',0,1,2,'standalone-chunk','fixture-model',1,x'0000803f',1 FROM compartments WHERE session_id=?1 AND sequence=1",
            [&session],
        )
        .unwrap();
    if run_move {
        apply_certified_move(&paths);
    }
    let (rig, answer) = Rig::try_setup_with_model(
        dir,
        MODULE,
        ("runner", &session),
        ("opencode", &session),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |_| {},
    )
    .await;
    *rig.runner.entries.lock().unwrap() = served_entries(&paths.opencode_db, &session);
    (rig, answer)
}

async fn settle_historian(rig: &Rig) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(std::sync::atomic::Ordering::Relaxed)
            > 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("historian evaluation finished");
}

#[tokio::test]
async fn moved_session_sets_up_from_the_import_and_carries_drops_onto_the_same_parts() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = moved_rig(dir.path(), true).await;
    let source = fixture::fixture();
    let expected = &source["expected"];
    assert_eq!(answer["answer"], "ready", "{answer}");
    // The selected cut is msg_m007: the fold end (the last covered message) is
    // msg_m006 at counted position 6, so the cut is the next message. msg_m007
    // is a user message with a text part and no neighbour at its time or time
    // + 1; the only older summary start at or below it is msg_m003. The message
    // before the cut is msg_m006.
    assert_eq!(
        answer["checkpoint"],
        json!({"tag_checkpoint": 20, "cut": "msg_m007", "message_count": 6,
            "head_cut":{"mid":"msg_m006","digest":"189f89a46681c05dac35fe71f4e46c1a8cb5a0c0882b1d5f4cc80ce3f4582ca9","written_at":1793145600123u64}})
    );
    rig.notice(1, 1_000, None).await;
    settle_historian(&rig).await;
    let state = rig.state();
    let namespace = state.namespace();
    let store = rig.h.store.get().unwrap();

    // The same summaries, re-anchored by message id onto the runner's ordinals.
    let imported = store.load_compartments(&namespace).unwrap();
    let standalone = source["context"]["compartments"].as_array().unwrap();
    assert_eq!(imported.len(), standalone.len());
    for (row, source) in imported.iter().zip(standalone) {
        assert_eq!(row.content, source["content"].as_str().unwrap());
        assert_eq!(row.p1.as_deref(), source["p1"].as_str());
        assert_eq!(row.p2.as_deref(), source["p2"].as_str());
        assert_eq!(
            row.importance as i64,
            source["importance"].as_i64().unwrap()
        );
        let start = state.mid_index[source["start_message_id"].as_str().unwrap()];
        let end = state.mid_index[source["end_message_id"].as_str().unwrap()];
        assert_eq!(
            (row.start_message, row.end_message),
            (start as i64, end as i64)
        );
    }
    // m001..m006 are ordinals 0..=5: the marker's summary message is not served.
    assert_eq!(imported.last().unwrap().end_message, 5);
    // msg_m007 is the seventh served message, hence ordinal 6.
    assert_eq!(state.mid_index["msg_m007"], 6);
    assert!(state.standalone_move.as_ref().unwrap().pending.is_none());

    // The first view replaces the summarized messages with the imported head,
    // and drops exactly the parts standalone had dropped.
    let view = rig.get(rig.newest().expect("a published view")).await;
    let view::ViewRange::Replace { bytes, .. } = &view.ranges[0] else {
        panic!("history head first: {:?}", view.ranges[0]);
    };
    assert_eq!(
        view.ranges
            .iter()
            .take_while(|r| matches!(r, view::ViewRange::Replace { .. }))
            .last()
            .unwrap()
            .to(),
        6,
        "the head covers m001..m006 (message_count 6, ending at the message before the cut)"
    );
    for compartment in standalone {
        assert!(bytes.contains(compartment["content"].as_str().unwrap()));
    }
    let dropped = view
        .ranges
        .iter()
        .flat_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.clone(),
            _ => Vec::new(),
        })
        .filter(|edit| edit.drop)
        .map(|edit| (edit.mid.clone(), edit.part.clone()))
        // Only numbered parts are drop targets; the engine also removes the
        // reasoning that belonged to a dropped part, which is its own rule.
        .filter(|(mid, part)| {
            state
                .tag_index
                .values()
                .any(|address| &address.mid == mid && &address.part == part)
        })
        .collect::<BTreeSet<_>>();
    let applied = expected["applied"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            (
                pair["mid"].as_str().unwrap().to_owned(),
                pair["part"].as_str().unwrap().to_owned(),
            )
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(dropped, applied);
    let _ = rig.render(&view);

    // Queued stamps are queued again on the runner's blocks. The file part has no
    // runner tag (files are not counted), so its drop is not carried.
    let queued = rig.pending_targets();
    let codec = codec::Codec::OpencodeAiSdk;
    let expected_queued = [("msg_m010", "prt_m010_a"), ("msg_m010", "prt_m010_b")]
        .iter()
        .map(|(mid, part)| {
            let tag = state
                .tag_index
                .iter()
                .find(|(_, address)| address.mid == *mid && address.part == *part)
                .map(|(tag, _)| tags::parse_tag(tag).unwrap())
                .unwrap();
            tag_row(&state, codec, tag).unwrap().unwrap().block_id
        })
        .collect::<Vec<_>>();
    // Each carried stamp is either still queued on its block or already applied
    // by the engine as an edit on the same part.
    let edited = view
        .ranges
        .iter()
        .flat_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.clone(),
            _ => Vec::new(),
        })
        .map(|edit| (edit.mid.clone(), edit.part.clone()))
        .collect::<BTreeSet<_>>();
    for ((mid, part), block) in [("msg_m010", "prt_m010_a"), ("msg_m010", "prt_m010_b")]
        .iter()
        .zip(&expected_queued)
    {
        assert!(
            queued.contains(block) || edited.contains(&((*mid).to_owned(), (*part).to_owned())),
            "carried stamp on {mid}/{part} was lost: queued {queued:?}"
        );
    }
    assert!(
        queued.iter().all(|target| expected_queued.contains(target)),
        "{queued:?} vs {expected_queued:?}"
    );

    // New numbers start above the checkpoint; old standalone numbers are unknown.
    assert!(state
        .tag_index
        .keys()
        .all(|tag| tags::parse_tag(tag).unwrap() > 20));
    let old = rig.tool(7, "ctx_reduce", json!({"drop":"13"})).await;
    assert_eq!(old["isError"], true, "{old}");
    let new = rig.tool(7, "ctx_reduce", json!({"drop":"21"})).await;
    assert_ne!(new["isError"], true, "{new}");

    // No summarizer call, and the standalone chunk embedding is copied.
    assert!(
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir.path())
            .sends()
            .is_empty(),
        "the import must not summarize again"
    );
    let embedding: Vec<(String, Vec<u8>)> = store
        .with_context_read(|conn| {
            conn.prepare(
                "SELECT chunk_hash,vector FROM compartment_chunk_embeddings WHERE session_id=?1",
            )?
            .query_map([&namespace], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .unwrap();
    assert_eq!(
        embedding,
        vec![("standalone-chunk".into(), vec![0, 0, 128, 63])]
    );

    // Every database this process holds open is a throwaway copy under the
    // system temp directory, never a live store.
    let open = std::process::Command::new("lsof")
        .args(["-p", &std::process::id().to_string(), "-Fn"])
        .output()
        .expect("lsof is required for the isolation check");
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let databases = String::from_utf8_lossy(&open.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .filter(|name| name.contains(".db"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert!(
        databases
            .iter()
            .any(|name| name.starts_with(&*dir.path().canonicalize().unwrap().to_string_lossy())),
        "lsof must see this test's stores: {databases:?}"
    );
    assert!(
        databases
            .iter()
            .all(|name| std::path::Path::new(name).starts_with(&temp)),
        "{databases:?}"
    );

    // Setup again: the same checkpoint and cut, permanently.
    let again = rig
        .op("compaction.setup", {
            let mut request = setup_request(&fixture::fixture_session(), "again");
            request["params"] = json!({"serializer_profile":"opencode-aisdk"});
            request
        })
        .await;
    assert_eq!(again["answer"], "ready", "{again}");
    // The second Setup returns the same cut (msg_m007) as the first Setup.
    assert_eq!(
        again["checkpoint"],
        json!({"tag_checkpoint": 20, "cut": "msg_m007"})
    );
}

#[tokio::test]
async fn setup_refuses_an_unmoved_standalone_session() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = moved_rig(dir.path(), false).await;
    assert_eq!(answer["answer"], "refuse", "{answer}");
    assert_eq!(
        answer["code"],
        offline_move::STANDALONE_SESSION_NOT_MIGRATED
    );
    assert!(
        load_head(rig.h.store.get().unwrap(), &rig.reference)
            .unwrap()
            .is_none(),
        "a refused setup must not create a conversation"
    );
}

#[tokio::test]
async fn moved_session_import_refuses_a_read_that_starts_after_the_history() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_rig(dir.path(), true).await;
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.retain(|entry| entry.mid != "msg_m001");
    }
    let state = rig.state();
    let mut state = state;
    let store = rig.h.store.get().unwrap();
    // Feed the shortened transcript through the same ingest a notice uses.
    for entry in rig.runner.entries.lock().unwrap().iter() {
        state.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    state.journal.complete = true;
    let refused = state.ingest_read(store, codec::Codec::OpencodeAiSdk);
    let Err(HandlerOutcome::Error { code, message }) = refused else {
        panic!("{refused:?}");
    };
    assert_eq!(code, PROTOCOL_ERROR);
    assert!(
        message.starts_with("moved_session_read_starts_after_history"),
        "{message}"
    );
}

fn peak_rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()
}

/// The one-time first read after the cutover, for a session shaped like a
/// 175,000-message head read whole in about 500 pages, then the import binding.
/// Peak memory is the whole test process, including the fake runner's own copy
/// of the transcript.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "cost measurement; run explicitly"]
async fn moved_175k_first_read_cost() {
    let dir = tempfile::tempdir().unwrap();
    let shape = fixture::Synthetic {
        messages: 175_000,
        tail: 1_600,
        text_bytes: 786,
        compartments: 200,
    };
    let paths = fixture::write_synthetic_stores(dir.path(), &shape);
    let session = fixture::SYNTHETIC_SESSION;
    let move_started = Instant::now();
    offline_move::run(&paths, session, false, &fixture::NoHolders, None).unwrap();
    let move_ms = move_started.elapsed().as_millis();
    let (rig, answer) = Rig::try_setup_with_model(
        dir.path(),
        MODULE,
        ("runner", session),
        ("opencode", session),
        "fixture",
        json!({"serializer_profile":"opencode-aisdk"}),
        |_| {},
    )
    .await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let served = served_entries(&paths.opencode_db, session);
    let bytes: usize = served
        .iter()
        .map(|entry| serde_json::to_vec(entry).unwrap().len())
        .sum();
    let count = served.len();
    rig.runner
        .page_size
        .store(350, std::sync::atomic::Ordering::Relaxed);
    *rig.runner.entries.lock().unwrap() = served;
    let rss_before = peak_rss_kib();
    // ck-mc's notice path reads with a 10-second budget and starts over when a
    // read does not finish within it. Read here with no practical budget to see
    // how long one whole read takes, then index and bind it as a notice does.
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let read_started = Instant::now();
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(3_600))
        .await
        .unwrap();
    let read_ms = read_started.elapsed().as_millis();
    let rss_after_read = peak_rss_kib();
    let pages = rig.runner.reads.lock().unwrap().len();
    let ingest_started = Instant::now();
    state
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .unwrap();
    let ingest_ms = ingest_started.elapsed().as_millis();
    let rss_after_ingest = peak_rss_kib();
    let held = state.entries.len();
    let pending_import = state
        .standalone_move
        .as_ref()
        .is_some_and(|moved| moved.pending.is_some());
    drop(state);
    // The first notice then finds every entry held and runs the engine pass.
    let last = rig.runner.entries.lock().unwrap().last().cloned().unwrap();
    let notice = notice::AdvanceNotice::new(
        &rig.reference,
        1,
        "L",
        last.ordinal,
        contract::digest::content_digest(&last.message),
        1_000,
        "fixture",
    )
    .with_window(100_000);
    let mut headers = notice.to_headers();
    headers.insert("lineage_id".into(), "L".into());
    let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
    let started = Instant::now();
    let _ = rig
        .bus
        .publish(
            &notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
            &bus_id(&rig.reference, "advanced", 1),
            notice.digest().parse().unwrap(),
            headers,
        )
        .await
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(900), async {
        loop {
            let state = load_head(store, &rig.reference).unwrap().unwrap();
            if state.completed_seq >= 1 {
                return "completed";
            }
            if state.failure.is_some() {
                return "failed";
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or("timed out");
    let notice_ms = started.elapsed().as_millis();
    let state = rig.state();
    let phases = [
        "phase:read",
        "phase:index",
        "phase:policy",
        "phase:publish",
        "phase:reminders",
        "phase:cadence",
        "pub:engine",
        "pub:certify",
        "pub:render",
        "pub:ranges",
        "save",
        "load",
    ]
    .iter()
    .map(|kind| {
        let stats = scaling_tests::save_meter::read_kind(&rig.reference, kind);
        format!("{kind}={}ms/{}", stats.wall_nanos / 1_000_000, stats.saves)
    })
    .collect::<Vec<_>>()
    .join(" ");
    println!("FIRST_READ_PHASES {phases}");
    println!(
        "FIRST_READ read_ms={read_ms} peak_after_read_kib={rss_after_read:?} pages={pages} messages={count} served_bytes={bytes} ingest_bind_ms={ingest_ms} peak_after_ingest_kib={rss_after_ingest:?} held={held} pending_import_after_bind={pending_import} compartments={} first_notice={outcome} first_notice_ms={notice_ms} published_views={} move_ms={move_ms} peak_rss_kib={:?} rss_before_read_kib={rss_before:?}",
        store.load_compartments(&state.namespace()).unwrap().len(),
        state.published_engine.len(),
        peak_rss_kib(),
    );
}
