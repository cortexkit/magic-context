use super::*;
use crate::offline_move::tests as fixture;

async fn applied_rig(dir: &Path) -> (Rig, view::CompactionView, Vec<Value>) {
    let (rig, answer) = moved_session::moved_rig(dir, true).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    rig.notice(1, 1_000, None).await;
    moved_session::settle_historian(&rig).await;
    let version = rig.newest().expect("import and drops publish a view");
    rig.notice(2, 1_000, Some(version)).await;
    moved_session::settle_historian(&rig).await;
    let applied = rig.get(version).await;
    assert_eq!(rig.state().applied, Some(version));
    let rendered = serde_json::from_slice(&rig.render(&applied)).unwrap();
    (rig, applied, rendered)
}

async fn recover(rig: &Rig) -> Value {
    let mut request = setup_request(&fixture::fixture_session(), "recover");
    request["lineage_id"] = json!("recovered");
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["answer"], "ready", "{answer}");
    *rig.runner.lineage.lock().unwrap() = "recovered".into();
    answer
}

/// The runner installs Setup's replacement once, then sends its first request
/// with the untouched rows outside the range. Recording those bytes here keeps
/// the oracle independent of the provider's retained-row renderer.
#[derive(Default)]
struct ModelRequests {
    requests: Vec<Vec<Value>>,
    rebuilds: usize,
}

impl ModelRequests {
    fn after_setup(&mut self, rig: &Rig, answer: &Value) -> &Vec<Value> {
        let initial = &answer["initial"];
        let from = initial["range"]["from"].as_u64().unwrap();
        let to = initial["range"]["to"].as_u64().unwrap();
        let origin = answer["checkpoint"]["message_count"].as_u64().unwrap();
        let entries = rig.runner.entries.lock().unwrap();
        let mut request = entries
            .iter()
            .filter(|e| e.ordinal >= origin && e.ordinal < from)
            .map(|e| e.message.clone())
            .collect::<Vec<_>>();
        request.extend(initial["replacement"].as_array().unwrap().iter().cloned());
        request.extend(
            entries
                .iter()
                .filter(|e| e.ordinal >= to)
                .map(|e| e.message.clone()),
        );
        // Descriptor-mode replacements carry media by reference. The fake
        // runner materializes them before the model sees the request.
        for message in &mut request {
            if let Some(parts) = message["parts"].as_array_mut() {
                for part in parts {
                    if let Some(id) = part["part"].as_str() {
                        if let Some(source) = entries
                            .iter()
                            .flat_map(|entry| entry.message["parts"].as_array().unwrap())
                            .find(|source| source["id"] == id)
                        {
                            *part = source.clone();
                        }
                    }
                }
            }
        }
        self.rebuilds += 1;
        self.requests.push(request);
        self.requests.last().unwrap()
    }

    async fn first_view(&mut self, rig: &Rig, answer: &Value) {
        rig.notice(99, 1_000, None).await;
        moved_session::settle_historian(rig).await;
        let view = rig
            .get(rig.newest().expect("recovered lineage publishes"))
            .await;
        let rendered: Vec<Value> = serde_json::from_slice(&rig.render(&view)).unwrap();
        let prefix_len = answer["initial"]["replacement"].as_array().unwrap().len();
        if !rendered.starts_with(&self.requests[0][..prefix_len]) {
            self.rebuilds += 1;
            for (index, (actual, expected)) in rendered
                .iter()
                .zip(&self.requests[0][..prefix_len])
                .enumerate()
            {
                assert_eq!(
                    actual, expected,
                    "first view changed installed prefix row {index}"
                );
            }
        }
        assert_eq!(
            self.rebuilds, 1,
            "the first view changed the installed prefix: {rendered:?}"
        );
    }
}

fn applied_target(rig: &Rig) -> super::super::moved_session::BoundDrop {
    rig.state()
        .standalone_move
        .unwrap()
        .bound_drops
        .into_iter()
        .find(|drop| drop.kind == crate::offline_move::DropKind::Applied)
        .unwrap()
}

#[tokio::test]
async fn adoption_recovery_unchanged_first_request_and_horizon() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied, mut expected) = applied_rig(dir.path()).await;
    let parent = rig.state();
    let old_namespace = parent.namespace();
    let old_seed = parent.cut_seed.as_ref().unwrap();
    let store = rig.h.store.get().unwrap();
    let imported = store.load_compartments(&old_namespace).unwrap();
    let last = applied.covers_through.ordinal;
    let extra = ReadMessage::new(last + 1, "new-after-view", json!({"info":{"id":"new-after-view","role":"user"},"parts":[{"id":"new-part","type":"text","text":"new raw horizon content"}]}))
        .with_tags(vec![tags::PartTag::tagged("new-part", "§900§")]);
    expected.push(extra.message.clone());
    rig.runner.entries.lock().unwrap().push(extra);
    rig.runner.reads.lock().unwrap().clear();
    rig.runner
        .page_size
        .store(1, std::sync::atomic::Ordering::Relaxed);
    let answer = recover(&rig).await;
    assert_eq!(answer["initial"]["range"], json!({"from":6,"to":last+1}));
    let mut model = ModelRequests::default();
    assert_eq!(model.after_setup(&rig, &answer), &expected);
    assert_eq!(model.rebuilds, 1);
    let child = rig.state();
    assert_ne!(child.namespace(), old_namespace);
    let new_seed = child.cut_seed.as_ref().unwrap();
    assert_eq!(new_seed.first_ordinal, old_seed.first_ordinal);
    assert_eq!(new_seed.cut_mid, old_seed.cut_mid);
    assert_eq!(new_seed.cut_digest, old_seed.cut_digest);
    assert_eq!(new_seed.time_basis, old_seed.time_basis);
    assert_eq!(new_seed.pre_cut_tags, old_seed.pre_cut_tags);
    assert_eq!(new_seed.max_tag, old_seed.max_tag);
    assert_eq!(new_seed.boundary_id, old_seed.boundary_id);
    assert_eq!(new_seed.compartment_seq, old_seed.compartment_seq);
    assert_eq!(
        serde_json::to_value(store.load_compartments(&child.namespace()).unwrap()).unwrap(),
        serde_json::to_value(imported).unwrap()
    );
    let artifacts = |namespace: &str| {
        store.with_context_read(|conn| {
        conn.prepare("SELECT chunk_hash,vector FROM compartment_chunk_embeddings WHERE session_id=?1 ORDER BY chunk_hash")?
            .query_map([namespace], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Vec<u8>>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()
    }).unwrap()
    };
    assert_eq!(artifacts(&child.namespace()), artifacts(&old_namespace));
    assert!(!artifacts(&child.namespace()).is_empty());
    assert!(child.entries.keys().all(|ordinal| *ordinal >= 6));
    let reads = rig.runner.reads.lock().unwrap();
    assert_eq!(reads[0]["from_ordinal"], 6);
    assert!(reads.iter().all(|read| read["lineage_id"] == "recovered"
        && read["from_ordinal"].as_u64().unwrap() >= 6
        && read["max_bytes"] == 1_048_576));
    drop(reads);
    assert_eq!(
        child.standalone_move.as_ref().unwrap().bound_drops,
        parent.standalone_move.as_ref().unwrap().bound_drops
    );
    let reads_before = rig.runner.read_starts();
    let repeat = recover(&rig).await;
    assert_eq!(repeat["initial"], answer["initial"]);
    assert_eq!(rig.runner.read_starts(), reads_before);
    model.first_view(&rig, &answer).await;
}

#[tokio::test]
async fn adoption_recovery_held_row_after_applied_horizon_renders_raw() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, applied, mut expected) = applied_rig(dir.path()).await;
    let last = applied.covers_through.ordinal;
    let extra = ReadMessage::new(last + 1, "held-after-view", json!({"info":{"id":"held-after-view","role":"user"},"parts":[{"id":"held-part","type":"text","text":"held but not in the last applied view"}]}))
        .with_tags(vec![tags::PartTag::tagged("held-part", "§901§")]);
    expected.push(extra.message.clone());
    rig.runner.entries.lock().unwrap().push(extra);
    rig.notice(3, 1_000, Some(applied.view_version)).await;
    moved_session::settle_historian(&rig).await;
    let parent = rig.state();
    assert!(parent.entries.contains_key(&(last + 1)));
    assert_eq!(parent.applied, Some(applied.view_version));
    let answer = recover(&rig).await;
    assert_eq!(answer["initial"]["range"], json!({"from":6,"to":last+1}));
    let mut model = ModelRequests::default();
    assert_eq!(model.after_setup(&rig, &answer), &expected);
    assert_eq!(
        model.requests[0].last().unwrap()["parts"][0]["text"],
        "held but not in the last applied view"
    );
    model.first_view(&rig, &answer).await;
}

#[tokio::test]
async fn adoption_recovery_removed_row_stays_absent_in_first_request() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _, previous) = applied_rig(dir.path()).await;
    let target = applied_target(&rig);
    let removed_from = rig.state().mid_index[&target.mid];
    rig.runner
        .entries
        .lock()
        .unwrap()
        .retain(|entry| entry.ordinal < removed_from);
    let answer = recover(&rig).await;
    let expected = previous
        .into_iter()
        .filter(|message| {
            let mid = message["info"]["id"].as_str();
            mid.is_none_or(|mid| {
                !mid.starts_with("msg_m")
                    || rig
                        .runner
                        .entries
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|entry| entry.mid == mid)
            })
        })
        .collect::<Vec<_>>();
    let mut model = ModelRequests::default();
    assert_eq!(model.after_setup(&rig, &answer), &expected);
    assert_eq!(model.rebuilds, 1);
    assert!(!answer["initial"]["replacement"]
        .to_string()
        .contains(&target.mid));
    model.first_view(&rig, &answer).await;
}

#[tokio::test]
async fn adoption_recovery_changed_digest_renders_current_content_without_old_drop() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _, mut expected) = applied_rig(dir.path()).await;
    let target = applied_target(&rig);
    let changed = {
        let mut entries = rig.runner.entries.lock().unwrap();
        let entry = entries
            .iter_mut()
            .find(|entry| entry.mid == target.mid)
            .unwrap();
        let mut message = entry.message.clone();
        let parts = message["parts"].as_array_mut().unwrap();
        let part = parts
            .iter_mut()
            .find(|part| part["id"] == target.part)
            .unwrap();
        let pointer = if part["type"] == "tool" {
            "/state/output"
        } else {
            "/text"
        };
        *part.pointer_mut(pointer).unwrap() = json!("current changed raw text");
        *entry = ReadMessage::new(entry.ordinal, entry.mid.clone(), message)
            .with_tags(entry.tags.clone());
        entry.clone()
    };
    // The changed part uses its current bytes and tag. Other unchanged parts
    // keep the previous view's drops, including another drop in this message.
    let mut raw = changed.message.clone();
    for (part, tag) in raw["parts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .zip(&changed.tags)
    {
        let pointer = if part["type"] == "tool" {
            "/state/output"
        } else {
            "/text"
        };
        if let (Some(text), Some(tag)) = (
            part.pointer(pointer).and_then(Value::as_str),
            tag.tag.as_deref(),
        ) {
            *part.pointer_mut(pointer).unwrap() = json!(format!("{tag} {text}"));
        }
    }
    let previous = expected
        .iter_mut()
        .find(|message| message["info"]["id"] == changed.mid)
        .unwrap();
    raw["parts"].as_array_mut().unwrap().retain(|part| {
        part["id"] == target.part
            || previous["parts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|kept| kept["id"] == part["id"])
    });
    *previous = raw;
    let answer = recover(&rig).await;
    let mut model = ModelRequests::default();
    assert_eq!(model.after_setup(&rig, &answer), &expected);
    assert_eq!(model.rebuilds, 1);
    let child = rig.state();
    assert!(!child
        .frozen_edits
        .served(&target.mid, &target.part, "current changed raw text"));
    assert!(answer["initial"]["replacement"]
        .to_string()
        .contains("current changed raw text"));
    model.first_view(&rig, &answer).await;
}

#[tokio::test]
async fn adoption_recovery_revert_removing_cut_keeps_certified_head_and_empty_suffix() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _, _) = applied_rig(dir.path()).await;
    // A supported revert removed the cut row and every later row but kept the
    // certified predecessor. With the marker gone, the runner answers the
    // certified head from its last Setup.
    rusqlite::Connection::open(dir.path().join("opencode.db"))
        .unwrap()
        .execute(
            "DELETE FROM part WHERE json_extract(data,'$.type')='compaction'",
            [],
        )
        .unwrap();
    rig.runner.entries.lock().unwrap().clear();
    let answer = recover(&rig).await;
    assert_eq!(answer["initial"]["range"], json!({"from":6,"to":6}));
    let mut model = ModelRequests::default();
    let request = model.after_setup(&rig, &answer);
    assert!(!request.is_empty(), "the imported history head survives");
    assert!(!request.iter().any(|row| row["info"]["id"]
        .as_str()
        .is_some_and(|id| id.starts_with("msg_m"))));
    assert_eq!(model.rebuilds, 1);
}

#[tokio::test]
async fn adoption_recovery_unreadable_setup_stores_nothing_then_retries() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, _, _) = applied_rig(dir.path()).await;
    let before = setup_checkpoint::message_checkpoint::snapshot(dir.path());
    rig.runner
        .refuses_setup_read
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let mut request = setup_request(&fixture::fixture_session(), "unreadable");
    request["lineage_id"] = json!("recovered");
    let answer = rig.op("compaction.setup", request).await;
    assert_eq!(answer["code"], "setup_suffix_unreadable", "{answer}");
    assert_eq!(
        setup_checkpoint::message_checkpoint::snapshot(dir.path()),
        before
    );
    assert_eq!(rig.state().lineage.as_deref(), Some("L"));
    assert!(rig.runner.sent.lock().unwrap().is_empty());
    rig.runner
        .refuses_setup_read
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let answer = recover(&rig).await;
    assert_eq!(answer["initial"]["range"]["from"], 6);
}
