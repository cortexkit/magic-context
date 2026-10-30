//! A completed run's notice can disagree with the caller-facing read digest.
//! Revalidating the same source prefix must not spend the model's prompt cache.
use super::*;

fn entry(n: u64, role: &str, content: Value, run: &str) -> ReadMessage {
    let mut entry = ReadMessage::new(n, format!("m{n}"), json!({"role":role,"content":[content]}))
        .with_tags(vec![tags::PartTag::tagged(
            format!("m{n}#0"),
            format!("§{}§", 100 + n * 3),
        )]);
    if role == "assistant" {
        entry.message["origin"] = json!({"provider_module_id":"openai","model_id":"gpt-test"});
    }
    entry.run = Some(
        serde_json::from_value(json!({
            "run_id":run,"episode":run,"final":n == 39
        }))
        .unwrap(),
    );
    entry
}

async fn held_drops(dir: &Path) -> (Rig, u64) {
    let rig = Rig::open(
        dir,
        "broca",
        "broca",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = (0..40).map(|n| {
        let (role, content) = match n % 4 {
            0 => ("user", json!({"type":"text","text":format!("request {n}")})),
            1 => ("assistant", json!({"type":"tool_call","tool_call_id":format!("c{n}"),"tool_name":"read","input":{"path":"f"}})),
            2 => ("tool", json!({"type":"tool_result","tool_call_id":format!("c{}",n-1),"output":{"kind":"text","text":"spent tool output ".repeat(500)},"is_error":false})),
            _ => ("assistant", json!({"type":"text","text":"final text"})),
        };
        entry(n, role, content, "old-run")
    }).collect();
    rig.history(4, "published work from the previous run");
    rig.notice(1, 8_000, None).await;
    let baseline = rig
        .newest()
        .expect("history publication establishes a served view");
    rig.notice(2, 8_000, Some(baseline)).await;
    rig.queue(&[118, 130, 142]).await;
    (rig, baseline)
}

async fn closing_mismatch(rig: &Rig) {
    // Model the runner's native notice-anchor hash, while descriptor reads
    // expose the same stateful block as plain text.
    let mut native = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    native["content"][0] = json!({"type":"text_with_state","text":"final text",
        "provider_state":{"format":"open_ai_responses_chatgpt","data":"opaque"}});
    let digest = contract::digest::content_digest(&native);
    eprintln!(
        "source-derived notice input={} digest={digest}",
        String::from_utf8(serde_jcs::to_vec(&native).unwrap()).unwrap()
    );
    let inline = rig
        .runner
        .entries
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .message
        .clone();
    eprintln!(
        "source-derived descriptor input={} digest={}",
        String::from_utf8(serde_jcs::to_vec(&inline).unwrap()).unwrap(),
        contract::digest::content_digest(&inline)
    );
    assert_ne!(
        digest,
        contract::digest::content_digest(
            &rig.runner.entries.lock().unwrap().last().unwrap().message
        )
    );
    let notice = notice::AdvanceNotice::new(&rig.reference, 3, "L", 39, digest, 8_000, "fixture")
        .with_window(100_000);
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", &rig.module, notice::ADVANCED_EVENT),
        id: bus_id(&rig.reference, "advanced", 3),
        digest: notice.digest().parse().unwrap(),
        headers: notice.to_headers(),
    };
    rig.h
        .advance_compaction_once("fixture", &message)
        .await
        .unwrap();
    assert!(
        rig.state().resync,
        "the mismatching notice still requires a full resync"
    );
    assert!(rig.state().resync_sources.is_some());
}

fn request_bytes(rig: &Rig, view: &view::CompactionView) -> Vec<u8> {
    let entries = rig.runner.entries.lock().unwrap();
    let mut messages = Vec::new();
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { bytes, .. } => {
                messages.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
            }
            view::ViewRange::Keep { from, to, edits } => {
                for entry in entries
                    .iter()
                    .filter(|entry| (*from..*to).contains(&entry.ordinal))
                {
                    let mut message = entry.message.clone();
                    let mut content = Vec::new();
                    for (part, tag) in message["content"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .zip(&entry.tags)
                    {
                        match edits
                            .iter()
                            .find(|edit| edit.ordinal == entry.ordinal && edit.part == tag.part)
                        {
                            Some(edit) if edit.drop => {}
                            Some(edit) => content
                                .push(serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap()),
                            None => content.push(part.clone()),
                        }
                    }
                    message["content"] = json!(content);
                    messages.push(message);
                }
            }
            _ => panic!("unknown range"),
        }
    }
    messages.extend(
        entries
            .iter()
            .filter(|entry| entry.ordinal > view.covers_through.ordinal)
            .map(|entry| entry.message.clone()),
    );
    serde_json::to_vec(&messages).unwrap()
}

fn last_decision(rig: &Rig) -> String {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn broca_new_run_after_identical_resync_defers_held_drops_at_eight_percent() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let pending = rig.pending_targets();
    let generation = rig.state().generation;
    let old_view = rig.get(baseline).await;
    let store = rig.h.store.get().unwrap();
    let namespace = rig.state().namespace();
    let mut serving = store.load(&namespace).unwrap();
    serving.meta.historian.firing_seq = 99;
    store
        .commit(
            &namespace,
            serving.row_version,
            &serving.core,
            &serving.meta,
        )
        .unwrap();
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap().push(entry(
        40,
        "user",
        json!({"type":"text","text":"next inbox prompt"}),
        "new-run",
    ));
    let expected = request_bytes(&rig, &old_view);
    rig.runner.reads.lock().unwrap().clear();
    rig.notice(4, 8_000, Some(baseline)).await;
    let version = rig.newest().expect("resync must reissue a view");
    assert!(
        version > baseline,
        "the contract still requires a higher version"
    );
    assert_eq!(
        rig.pending_targets(),
        pending,
        "resync alone must not land held drops"
    );
    assert!(
        rig.state().generation > generation,
        "resync still invalidates in-flight work"
    );
    assert!(
        store
            .load_meta(&rig.state().namespace())
            .unwrap()
            .meta
            .historian
            .firing_seq
            < 99,
        "serving-state replay must not transfer historian claim state"
    );
    assert_eq!(
        request_bytes(&rig, &rig.get(version).await),
        expected,
        "the next request keeps the exact served prefix and appends only the new prompt"
    );
    assert_eq!(rig.runner.read_starts()[0], 0, "the full resync still runs");
    let decision = last_decision(&rig);
    assert!(decision.starts_with("async decision defer "), "{decision}");
    assert!(decision.contains("usage=8.0%"), "{decision}");
    assert!(!decision.contains("+rebuild"), "{decision}");
    rig.notice(5, 8_000, Some(version)).await;
    assert_eq!(
        rig.newest(),
        Some(version),
        "an ordinary notice does not reissue again"
    );
    assert_eq!(rig.pending_targets(), pending);
}

#[tokio::test]
async fn changed_source_resync_still_rebuilds_and_lands_held_drops() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let generation = rig.state().generation;
    closing_mismatch(&rig).await;
    rig.runner.entries.lock().unwrap()[15].message["content"][0]["text"] =
        json!("rewritten source");
    rig.notice(4, 8_000, Some(baseline)).await;
    assert!(rig.state().generation > generation);
    assert!(rig.newest().unwrap() > baseline);
    assert!(
        rig.pending_targets().is_empty(),
        "a changed prefix remains a rebuild"
    );
    let decision = last_decision(&rig);
    assert!(
        decision.starts_with("async decision execute "),
        "{decision}"
    );
    assert!(decision.contains("+rebuild"), "{decision}");
}

#[tokio::test]
async fn genuine_lineage_change_revalidates_and_rebuilds_once() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, baseline) = held_drops(dir.path()).await;
    let generation = rig.state().generation;
    *rig.runner.lineage.lock().unwrap() = "new-lineage".into();
    rig.notice(3, 8_000, None).await;
    let version = rig.newest().unwrap();
    assert!(version > baseline);
    assert!(rig.state().generation > generation);
    assert_eq!(rig.state().last_transferred_drops, 3);
    assert!(rig.pending_targets().is_empty());
    assert!(last_decision(&rig).contains("+rebuild"));
    rig.queue(&[154]).await;
    let pending = rig.pending_targets();
    rig.notice(4, 8_000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
    assert_eq!(rig.pending_targets(), pending);
    assert!(last_decision(&rig).starts_with("async decision defer "));
}
