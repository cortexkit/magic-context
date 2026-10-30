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
    let rows: Vec<String> = query
        .query_map([session], |row| row.get::<_, String>(0))
        .unwrap()
        .filter_map(|raw| raw.ok())
        .collect();
    rows.into_iter()
        .filter_map(|raw| {
            let data: Value = serde_json::from_str(&raw).ok()?;
            let key: tags::MarkerCheckpoint =
                serde_json::from_value(data["cortexkit"].clone()).ok()?;
            (key.session == session && key.message_count.is_some() && key.head_cut.is_some())
                .then_some(key)
        })
        .next()
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
    moved_rig_stage(dir, run_move, true).await
}

async fn moved_offline_setup_rig(dir: &Path) -> (Rig, Value) {
    moved_rig_stage(dir, true, false).await
}

pub(super) async fn prepare_for_live(h: &McHandler, dir: &Path, request: Value) -> Value {
    let describe = h
        .provider_runner
        .call(
            dir,
            &fixture::fixture_session(),
            "role.describe",
            json!({}),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
    let setup = super::super::offline_first_pass::OfflineSetup {
        request: decode(&request).unwrap(),
        project_root: dir.into(),
        runner_module: MODULE.into(),
        runner_describe: describe,
    };
    h.offline_first_pass(&setup).await.unwrap();
    let binding = SessionBinding {
        principal: Some(subc_protocol::Principal::Reserved {
            module_id: MODULE.into(),
        }),
        scope: None,
        project_root: dir.into(),
        harness: "runner".into(),
        session: fixture::fixture_session(),
        model_key: None,
        config: h.effective_config(dir),
        history_budget_tokens: 4_000.0,
    };
    serde_json::from_slice(&h.async_setup(7, &binding, &request).await.unwrap()).unwrap()
}

async fn moved_rig_stage(dir: &Path, run_move: bool, prepare: bool) -> (Rig, Value) {
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
    let (rig, mut answer) = Rig::try_setup_with_model(
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
    if run_move && answer["code"] == "moved_session_unprepared" {
        let request = json!({"session":session,"harness":"opencode","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":"L","now":1});
        if prepare {
            answer = prepare_for_live(&rig.h, dir, request).await;
        } else {
            let marker = super::super::offline_first_pass::OfflineFirstPass {
                version: super::super::offline_first_pass::MARKER_VERSION,
                state: super::super::offline_first_pass::PreparationState::Preparing,
                bound_generation: None,
                setup: super::super::offline_first_pass::setup_identity_digest(
                    &decode(&request).unwrap(),
                    MODULE,
                )
                .unwrap(),
                describe: None,
                inputs: None,
                proof: None,
            };
            let binding = SessionBinding {
                principal: Some(subc_protocol::Principal::Reserved {
                    module_id: MODULE.into(),
                }),
                scope: None,
                project_root: dir.into(),
                harness: "runner".into(),
                session,
                model_key: None,
                config: rig.h.effective_config(dir),
                history_budget_tokens: 4_000.0,
            };
            answer = serde_json::from_slice(
                &rig.h
                    .async_setup_inner(7, &binding, &request, Some(marker))
                    .await
                    .unwrap(),
            )
            .unwrap();
        }
    }
    if answer["answer"] == "ready" {
        *rig.runner.setup_checkpoint.lock().unwrap() =
            serde_json::from_value::<contract::setup::SetupAnswer>(answer.clone())
                .unwrap()
                .checkpoint()
                .cloned();
    }
    (rig, answer)
}

pub(super) async fn settle_historian(rig: &Rig) {
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

    // The same summaries, imported at ordinals 0..message_count-1 with the
    // offline-computed CK block ids. The runner never serves anything below the
    // cut, so pre-cut message ids are not in the held index.
    let imported = store.load_compartments(&namespace).unwrap();
    let standalone = source["context"]["compartments"].as_array().unwrap();
    assert_eq!(imported.len(), standalone.len());
    let record = crate::offline_move::read_move_record(
        &rusqlite::Connection::open(dir.path().join("context.db")).unwrap(),
        &fixture::fixture_session(),
    )
    .unwrap()
    .unwrap()
    .unwrap();
    for ((row, source), manifest) in imported.iter().zip(standalone).zip(&record.compartments) {
        assert_eq!(row.content, source["content"].as_str().unwrap());
        assert_eq!(row.p1.as_deref(), source["p1"].as_str());
        assert_eq!(row.p2.as_deref(), source["p2"].as_str());
        assert_eq!(
            row.importance as i64,
            source["importance"].as_i64().unwrap()
        );
        // Positions are 1-based in the manifest; ordinals are 0-based.
        assert_eq!(
            (row.start_message, row.end_message),
            (
                source["start_message"].as_i64().unwrap() - 1,
                source["end_message"].as_i64().unwrap() - 1
            )
        );
        let start_block = manifest.start_block.unwrap();
        let end_block = manifest.end_block.unwrap();
        assert_eq!(
            row.start_message_id,
            format!("{}#{start_block}", manifest.start_message_id)
        );
        assert_eq!(
            row.end_message_id,
            format!("{}#{end_block}", manifest.end_message_id)
        );
        assert_eq!(row.sequence, manifest.sequence);
    }
    // The seed keeps the last sequence and the boundary of the last imported
    // row, the certified digest and time basis, and the pre-cut tag range.
    let seed = state.cut_seed.as_ref().expect("adoption seed");
    assert_eq!(seed.first_ordinal, 6);
    assert_eq!(state.lineage_first_ordinal, 6);
    assert_eq!(seed.cut_mid, "msg_m006");
    assert_eq!(
        seed.cut_digest,
        "189f89a46681c05dac35fe71f4e46c1a8cb5a0c0882b1d5f4cc80ce3f4582ca9"
    );
    assert!(seed.time_basis.is_some());
    assert_eq!(seed.pre_cut_tags, vec![(1, 20)]);
    assert_eq!(seed.max_tag, 20);
    assert_eq!(seed.compartment_seq, 2);
    assert_eq!(seed.boundary_id, imported.last().unwrap().end_message_id);
    // No held row lives below the cut.
    assert!(state.entries.keys().all(|ordinal| *ordinal >= 6));
    assert!(state.mid_index.keys().all(|mid| mid.as_str() >= "msg_m007"));
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

    // New numbers start above the checkpoint; old standalone numbers are below
    // the cut, so they answer as already summarized rather than unknown.
    assert!(state
        .tag_index
        .keys()
        .all(|tag| tags::parse_tag(tag).unwrap() > 20));
    let old = rig.tool(7, "ctx_reduce", json!({"drop":"13"})).await;
    assert_eq!(old["isError"], false, "{old}");
    assert!(
        old.to_string().contains("already in the history summary"),
        "old tag 13 must answer below the cut: {old}"
    );
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
    // The second Setup returns the same cut (msg_m007) as the first Setup, with
    // the same certified checkpoint.
    assert_eq!(
        again["checkpoint"],
        json!({"tag_checkpoint": 20, "cut": "msg_m007", "message_count": 6,
            "head_cut":{"mid":"msg_m006","digest":"189f89a46681c05dac35fe71f4e46c1a8cb5a0c0882b1d5f4cc80ce3f4582ca9","written_at":1793145600123u64}})
    );
}

#[tokio::test]
async fn moved_setup_initial_contains_imported_history_head() {
    // The one Setup rule owns every lineage-start `initial`: the bootstrap
    // runs before the Setup engine pass, so the rendered head already
    // includes the imported history. The offline Setup's `initial` is an
    // empty `[message_count, message_count)` insertion whose replacement is
    // the imported history head, not an empty head.
    let dir = tempfile::tempdir().unwrap();
    let (_rig, answer) = moved_offline_setup_rig(dir.path()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    assert_eq!(
        answer["initial"]["range"],
        json!({"from": 6, "to": 6}),
        "moved Setup initial is the head insertion at the cut: {answer}"
    );
    let replacement = answer["initial"]["replacement"]
        .as_array()
        .expect("Setup initial carries the history head");
    assert!(
        !replacement.is_empty(),
        "history head is not empty: {answer}"
    );
    let source = fixture::fixture();
    let compartments = source["context"]["compartments"].as_array().unwrap();
    let bytes = serde_json::to_string(replacement).unwrap();
    for compartment in compartments {
        let content = compartment["content"].as_str().unwrap();
        assert!(
            bytes.contains(content),
            "Setup initial must contain the imported history head: missing {content:?}"
        );
    }
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
async fn moved_session_first_read_binds_without_pre_cut_rows() {
    // The adoption bootstrap imports the prefix at Setup, so the first read is
    // drops-only and never serves anything below the cut. A read starting at
    // the cut (without pre-cut rows) must succeed and bind drops.
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_offline_setup_rig(dir.path()).await;
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.retain(|entry| entry.ordinal >= 6);
    }
    let state = rig.state();
    let mut state = state;
    let store = rig.h.store.get().unwrap();
    // Feed only the post-cut transcript through the same ingest a notice uses.
    for entry in rig.runner.entries.lock().unwrap().iter() {
        state.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    state.journal.complete = true;
    state
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .expect("drops-only first read binds");
    assert!(state
        .standalone_move
        .as_ref()
        .is_some_and(|moved| moved.pending.is_none()));
    assert!(!state
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.is_empty())
        .unwrap_or(true));
}

#[tokio::test]
async fn importing_stage_restarts_from_the_move_record() {
    // A crash between the `importing` save (cut set, initial still null) and the
    // final Setup save must restart from the move record and never answer the
    // partial record as complete.
    let dir = tempfile::tempdir().unwrap();
    let (rig, answer) = moved_offline_setup_rig(dir.path()).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    let store = rig.h.store.get().unwrap();
    // Simulate the crash: keep the cut stage, drop the complete initial.
    let mut state = rig.state();
    assert!(state.cut_first_ordinal.is_some());
    state.initial = Value::Null;
    state.save(store, &[]).unwrap();
    let stored = load_head(store, &rig.reference).unwrap().unwrap();
    assert!(stored.is_importing_stage(), "must look importing");
    // A repeat offline Setup restarts the import; live callers cannot adopt it.
    let request = {
        let mut request = setup_request(&fixture::fixture_session(), "retry");
        request["params"] = json!({"serializer_profile":"opencode-aisdk"});
        request
    };
    let binding = rig.h.async_binding(&stored);
    let again: Value = serde_json::from_slice(
        &rig.h
            .async_setup_inner(7, &binding, &request, stored.offline_first_pass.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(again["answer"], "ready", "{again}");
    assert_eq!(
        again["checkpoint"], answer["checkpoint"],
        "{again} vs {answer}"
    );
    let restored = rig.state();
    assert!(!restored.is_importing_stage());
    assert_eq!(restored.lineage_first_ordinal, 6);
    assert!(restored.cut_seed.is_some());
}

#[tokio::test]
async fn second_bind_adds_no_duplicate_and_keeps_the_move_record() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_offline_setup_rig(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    // First bind through the same ingest a notice uses, without running the
    // engine in between so nothing consumes the queue.
    let mut first = rig.state();
    for entry in rig.runner.entries.lock().unwrap().iter() {
        if entry.ordinal < 6 {
            continue;
        }
        first.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(entry).unwrap()),
        );
    }
    first.journal.complete = true;
    first
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .expect("first bind");
    first.save(store, &[]).unwrap();
    let pending_before = store.load_pending_agent_drops(&first.namespace()).unwrap();
    let frozen_before = first.frozen_edits.json().unwrap();
    assert!(first
        .standalone_move
        .as_ref()
        .is_some_and(|moved| moved.pending.is_none()));
    assert!(!first
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.is_empty())
        .unwrap_or(true));
    // The authoritative move record is never cleared.
    let raw = offline_move::read_move_record_raw(
        &rusqlite::Connection::open(dir.path().join("context.db")).unwrap(),
        &fixture::fixture_session(),
    )
    .unwrap()
    .expect("move record survives binding");
    let kept: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(kept["state"], "moved");
    // A second bind in the same namespace is idempotent: no duplicate edit or
    // queue row, and still only its own pending marker cleared.
    let mut again = first;
    again.journal.complete = true;
    again
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .expect("second bind");
    let pending_after = store.load_pending_agent_drops(&again.namespace()).unwrap();
    assert_eq!(pending_before.len(), pending_after.len());
    assert_eq!(frozen_before, again.frozen_edits.json().unwrap());
    assert!(again
        .standalone_move
        .as_ref()
        .is_some_and(|moved| moved.pending.is_none()));
}

/// A runner may key a message's parts by position ("0", "1", …), as
/// THALAMUS's OpenCode runner does, while the move recorded each drop target
/// by OpenCode's part id. The bind resolves the host id through the served
/// message's parts, and stores the runner's key.
#[tokio::test]
async fn drops_bind_when_the_runner_keys_parts_by_position() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_offline_setup_rig(dir.path()).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    for entry in rig.runner.entries.lock().unwrap().iter() {
        if entry.ordinal < 6 {
            continue;
        }
        let mut entry = entry.clone();
        let keys: std::collections::HashMap<String, String> = entry
            .tags
            .iter()
            .enumerate()
            .map(|(index, row)| (row.part.clone(), index.to_string()))
            .collect();
        for row in &mut entry.tags {
            row.part = keys[&row.part].clone();
        }
        if let Some(digests) = &mut entry.part_digests {
            for row in digests {
                row.part = keys[&row.part].clone();
            }
        }
        state.entries.insert(
            entry.ordinal,
            Arc::new(HeldEntry::from_read(&entry).unwrap()),
        );
    }
    state.journal.complete = true;
    state
        .ingest_read(store, codec::Codec::OpencodeAiSdk)
        .expect("drops bind through positional keys");
    let moved = state.standalone_move.as_ref().unwrap();
    assert!(moved.pending.is_none());
    assert!(!moved.bound_drops.is_empty());
    assert!(
        moved
            .bound_drops
            .iter()
            .all(|drop| drop.part.parse::<usize>().is_ok()),
        "bound drops keep the runner's keys: {:?}",
        moved.bound_drops
    );
}

#[tokio::test]
async fn unbindable_drop_target_refuses_drop_target_unbound() {
    // A carried drop whose served part has no tag cannot be bound: fail closed.
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_offline_setup_rig(dir.path()).await;
    // Drop the applied target msg_m008 entirely, so no served part matches it.
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.retain(|entry| entry.mid != "msg_m008");
    }
    let mut state = rig.state();
    let store = rig.h.store.get().unwrap();
    for entry in rig.runner.entries.lock().unwrap().iter() {
        // Only post-cut rows are ever served; pre-cut rows are never requested.
        if entry.ordinal < 6 {
            continue;
        }
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
    assert!(message.contains("drop_target_unbound"), "{message}");
}

#[tokio::test]
async fn replay_skips_removed_and_changed_digests() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let bound = state
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.clone())
        .unwrap();
    assert!(!bound.is_empty());
    // Removed target: drop its tag row so no served part matches, and drop its
    // held entry so the replay sees it as gone rather than untagged.
    let removed = bound
        .iter()
        .find(|drop| drop.kind == crate::offline_move::DropKind::Applied)
        .unwrap()
        .clone();
    let tag_to_drop = state
        .tag_index
        .iter()
        .find(|(_, address)| address.mid == removed.mid && address.part == removed.part)
        .map(|(tag, _)| tag.clone());
    if let Some(tag) = tag_to_drop {
        state.tag_index.remove(&tag);
    }
    if let Some(ordinal) = state.mid_index.get(&removed.mid).copied() {
        state.entries.remove(&ordinal);
    }
    state.journal.complete = true;
    state
        .bind_standalone_move(store, codec::Codec::OpencodeAiSdk)
        .expect("removed target is skipped, not refused");
    // Changed digest: serve the same part with a different digest. The old drop
    // must not be applied to the changed content.
    let mut changed = rig.state();
    let changed_target = bound
        .iter()
        .find(|drop| drop.kind == crate::offline_move::DropKind::Applied)
        .unwrap();
    for address in changed.tag_index.values_mut() {
        if address.mid == changed_target.mid && address.part == changed_target.part {
            address.digest = "changed-digest".into();
        }
    }
    changed.journal.complete = true;
    changed
        .bind_standalone_move(store, codec::Codec::OpencodeAiSdk)
        .expect("changed digest is skipped, not dropped");
}

#[tokio::test]
async fn replay_same_digest_untagged_refuses_before_any_model_call() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    settle_historian(&rig).await;
    let store = rig.h.store.get().unwrap();
    let mut state = rig.state();
    let bound = state
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.clone())
        .unwrap();
    let target = bound
        .iter()
        .find(|drop| drop.kind == crate::offline_move::DropKind::Applied)
        .unwrap()
        .clone();
    // Keep the held part with its digest but drop its tag, so the same-digest
    // part is served untagged. The replay must refuse before any model call.
    let tag_to_drop = state
        .tag_index
        .iter()
        .find(|(_, address)| address.mid == target.mid && address.part == target.part)
        .map(|(tag, _)| tag.clone());
    let dropped = tag_to_drop.map(|tag| state.tag_index.remove(&tag).unwrap());
    assert!(dropped.is_some(), "expected a tagged applied target");
    state.journal.complete = true;
    let refused = state.bind_standalone_move(store, codec::Codec::OpencodeAiSdk);
    let Err(HandlerOutcome::Error { code, message }) = refused else {
        panic!("{refused:?}");
    };
    assert_eq!(code, PROTOCOL_ERROR);
    assert!(message.contains("drop_target_unbound"), "{message}");
}

#[tokio::test]
async fn rebinding_into_a_fresh_generation_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _) = moved_rig(dir.path(), true).await;
    rig.notice(1, 1_000, None).await;
    settle_historian(&rig).await;
    let first_namespace = rig.state().namespace();
    let first_bound = rig
        .state()
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.clone())
        .unwrap();
    assert!(!first_bound.is_empty());
    // Move to a fresh generation on a new lineage with the same certified cut.
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    let mut request = setup_request(&fixture::fixture_session(), "gen2");
    request["params"] = json!({"serializer_profile":"opencode-aisdk"});
    request["lineage_id"] = json!("L2");
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    rig.notice(2, 1_000, None).await;
    settle_historian(&rig).await;
    let state = rig.state();
    assert_ne!(state.namespace(), first_namespace);
    let rebased = state
        .standalone_move
        .as_ref()
        .map(|moved| moved.bound_drops.clone())
        .unwrap();
    assert_eq!(rebased, first_bound);
    assert!(state
        .standalone_move
        .as_ref()
        .is_some_and(|moved| moved.pending.is_none()));
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
