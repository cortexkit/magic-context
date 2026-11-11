use super::*;
use crate::context_db::{StoredCompartment, StoredMemory};
use crate::summary::head::{delta, fold, head_ops, Inputs};
use cortexkit_role_compaction::view::Edit;
use std::collections::BTreeMap;

fn rendered(mural: bool, empty: bool, mismatch: bool) -> (ReadState, Vec<String>) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("ARCHITECTURE.md"),
        "# Architecture\nKeep the prefix stable.\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("STRUCTURE.md"),
        "# Structure\nSources live in src/.\n",
    )
    .unwrap();
    let docs = crate::project_docs::read_project_docs_canonical(dir.path().to_str().unwrap());
    let summaries = [StoredCompartment {
        sequence: 1,
        start_message: 1,
        end_message: 4,
        title: "Earlier work".into(),
        content: "Preserved the cache.".into(),
        p1: Some("Preserved the cache.".into()),
        importance: 90,
        ..Default::default()
    }];
    let memories = [StoredMemory {
        id: 1,
        category: "PROJECT_RULES".into(),
        content: "Expand §42§ for evidence.\nKeep the original bytes.".into(),
        importance: Some(90),
        status: "active".into(),
        ..Default::default()
    }];
    let profile = vec!["Prefer concise explanations.".into()];
    let mut inputs = Inputs {
        counter: Counter::for_model(Some("provider/model")),
        summaries: &summaries,
        docs: &docs.rendered_block,
        profile: &profile,
        profile_max_id: 1,
        memories: &memories,
        workspace: None,
        gone: &[],
        history_budget_tokens: 10000,
        history_local_budget_tokens: 10000,
        memory_budget_tokens: 4000,
        profile_budget_tokens: 1000,
    };
    let baseline = fold(&inputs, mural.then_some("tiny-mural"));
    let mut newer = summaries.to_vec();
    newer.push(StoredCompartment {
        sequence: 2,
        start_message: 5,
        end_message: 8,
        title: "New work".into(),
        content: "Added a head read.".into(),
        p1: Some("Added a head read.".into()),
        importance: 90,
        ..Default::default()
    });
    let mut changed = memories.to_vec();
    changed[0].content = "Expand §43§ for updated evidence.".into();
    let new_profile = vec!["Prefer concise explanations and concrete evidence.".into()];
    if !empty {
        inputs.summaries = &newer;
        inputs.memories = &changed;
        inputs.profile = &new_profile;
        inputs.profile_max_id = 2;
    }
    let (m1, baseline, _) = delta(&baseline, &inputs);
    // A one-pixel PNG keeps the image contract readable without a large fixture.
    let image = mural.then(||InsertedImage::new("image/png", "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII="));
    let ops = head_ops(&baseline.m0, &m1, image);
    let texts = ops
        .iter()
        .map(|op| match op {
            EditOp::Insert { message, .. } => message.texts.join("\n"),
            _ => unreachable!(),
        })
        .collect();
    let view = View::seal(7, ops.into_iter().map(|op| Edit::new(7, op)).collect());
    let baseline = if mismatch {
        Arc::new(Baseline {
            m0: "<session-history></session-history>".into(),
            ..Default::default()
        })
    } else {
        Arc::new(baseline)
    };
    let mut state = ReadState::default();
    state.record(&view, Some(baseline), "provider/model");
    state.confirm(7);
    (state, texts)
}

fn snapshot() -> Snapshot {
    crate::session::Session::app_sample_snapshot()
}

fn reconstruct(message: &Value) -> String {
    if message["empty"] == true {
        return message["placeholder"].as_str().unwrap().into();
    }
    let sections = message["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|section| section["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    if message["slot"] == "delta" {
        format!(
            "{}\n{}\n{}",
            message["wrapper"]["open"].as_str().unwrap(),
            sections.join("\n"),
            message["wrapper"]["close"].as_str().unwrap()
        )
    } else {
        sections.join("\n\n")
    }
}

#[test]
fn split_real_renders_reconstructs_both_messages_and_bare_tags() {
    for empty in [false, true] {
        let (state, texts) = rendered(true, empty, false);
        let result = read(&snapshot(), Some(&state)).unwrap();
        for (message, text) in result["messages"].as_array().unwrap().iter().zip(texts) {
            assert_eq!(reconstruct(message), text);
            assert_eq!(
                message["tokens"],
                Counter::for_model(Some("provider/model")).count(&text)
            );
        }
        let memory = &result["messages"][0]["sections"][3];
        assert!(memory["text"]
            .as_str()
            .unwrap()
            .contains("Expand 42 for evidence."));
        assert!(!memory["text"].as_str().unwrap().contains('§'));
        assert_eq!(memory["items"][0]["id"], 1);
        assert_eq!(memory["items"][0]["category"], "PROJECT_RULES");
        assert!(memory["items"][0]["text"]
            .as_str()
            .unwrap()
            .contains("\n  Keep the original bytes."));
        assert_eq!(
            result["messages"][0]["sections"].as_array().unwrap().len(),
            5
        );
        assert_eq!(
            result["messages"][0]["sections"][2]["items"][0]["compartment_id"],
            "1"
        );
        if !empty {
            assert_eq!(
                result["messages"][1]["sections"].as_array().unwrap().len(),
                3
            );
            assert_eq!(
                result["messages"][1]["sections"][1]["items"][0]["compartment_id"],
                "2"
            );
            assert_eq!(
                result["messages"][1]["sections"][0]["items"][0]["form"],
                "full"
            );
        }
    }
}

#[test]
fn unknown_sessions_and_not_ready_are_refused_without_rendering() {
    let mut replica = super::super::tests::replica(None);
    let params = super::super::tests::request(json!({}));
    assert_eq!(
        replica.read("context.head", &params).unwrap_err().code,
        "head_not_ready"
    );
    replica.snapshots.clear();
    let head = replica.read("context.head", &params).unwrap_err();
    let states = replica
        .read(
            "context.states",
            &super::super::tests::request(json!({"message_ids":["m1"]})),
        )
        .unwrap_err();
    assert_eq!(head, states);
}

#[test]
fn mismatched_attribution_is_omitted_and_counts_follow_the_serving_model() {
    let (mut state, texts) = rendered(true, false, true);
    let counter = Counter::for_model(Some("anthropic/claude-opus-5-5"));
    state.counter = Some(counter);
    let result = read(&snapshot(), Some(&state)).unwrap();
    let baseline = &result["messages"][0];
    assert_eq!(baseline["tokens"], counter.count(&texts[0]));
    assert_eq!(
        baseline["sections"][0]["items"].as_array().unwrap().len(),
        2
    );
    assert!(baseline["sections"][2].get("items").is_none());
    assert_eq!(baseline["sections"][3]["items"][0]["id"], 1);
    assert!(result["messages"][1]["sections"][0].get("items").is_none());
    assert!(result["messages"][1]["sections"][1].get("items").is_none());
    let image = &baseline["sections"][4]["image"];
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(image["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(image["sha256"], format!("{:x}", Sha256::digest(bytes)));
    assert!(image["tokens"].is_null());
}

#[test]
fn unchanged_slots_share_their_text_and_baseline() {
    let (mut state, _) = rendered(true, false, false);
    let before = state.offered.clone().unwrap();
    let ops = head_ops(
        &before.slots[0].text,
        &before.slots[1].text,
        before.slots[0].image.clone(),
    );
    let view = View::seal(8, ops.into_iter().map(|op| Edit::new(7, op)).collect());
    state.record(&view, before.baseline.clone(), "provider/model");
    let after = state.offered.as_ref().unwrap();
    for (old, new) in before.slots.iter().zip(&after.slots) {
        assert!(Arc::ptr_eq(old, new));
    }
    assert!(Arc::ptr_eq(
        before.baseline.as_ref().unwrap(),
        after.baseline.as_ref().unwrap()
    ));
    assert_eq!(
        read(&snapshot(), Some(&state)).unwrap()["as_of"]["applied"],
        false
    );
    state.offered = None;
    assert_eq!(read(&snapshot(), Some(&state)).unwrap()["as_of"]["view"], 7);
}

#[test]
fn samples_v11() {
    let mut samples = BTreeMap::<String, Vec<u8>>::new();
    let v10 =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v10");
    for line in std::fs::read_to_string(v10.join("SHA256SUMS"))
        .unwrap()
        .lines()
    {
        let (_, name) = line.split_once("  ").unwrap();
        samples.insert(name.into(), std::fs::read(v10.join(name)).unwrap());
    }
    for name in [
        "head",
        "head-empty-delta",
        "head-pending-view",
        "head-worker",
        "head-suspended",
        "head-no-mural",
        "head-not-ready",
        "head-no-items",
    ] {
        let (mut state, _) = rendered(
            name != "head-no-mural",
            name == "head-empty-delta",
            name == "head-no-items",
        );
        if name == "head-pending-view" {
            state.confirmed = None;
        }
        if name == "head-worker" {
            state = ReadState {
                ready: true,
                ..Default::default()
            };
        }
        let mut snapshot = snapshot();
        if name == "head-suspended" {
            let mut breakdown = snapshot.breakdown.to_value();
            breakdown["managed"]["value"] = json!(false);
            snapshot.breakdown = super::super::Breakdown::from_value(breakdown);
        }
        let response = match read(&snapshot, (name != "head-not-ready").then_some(&state)) {
            Ok(result) => json!({"result":result}),
            Err(refusal) => json!({"error":refusal}),
        };
        let sample = json!({"name":name,"request":{"method":"context.head","params":{"session":snapshot.key}},"response":response});
        samples.insert(
            format!("{name}.json"),
            format!("{}\n", serde_json::to_string_pretty(&sample).unwrap()).into_bytes(),
        );
    }
    let mut root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-app-read-samples-v11");
    let output = std::env::var_os("MC_REGENERATE_APP_READ_SAMPLES");
    let regenerate = output.is_some();
    if let Some(output) = output.filter(|value| value != "1") {
        root = output.into();
    }
    if regenerate {
        std::fs::create_dir_all(&root).unwrap();
    }
    let mut sums = String::new();
    for (name, bytes) in samples {
        let decoded: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(decoded["request"]["method"].is_string());
        sums.push_str(&format!("{:x}  {name}\n", Sha256::digest(&bytes)));
        if regenerate {
            std::fs::write(root.join(&name), &bytes).unwrap();
        }
        assert_eq!(
            std::fs::read(root.join(&name)).unwrap_or_else(|_| panic!("missing sample {name}")),
            bytes,
            "stale {name}"
        );
        println!("sample {name}: {} bytes", bytes.len());
    }
    if regenerate {
        std::fs::write(root.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("SHA256SUMS")).unwrap(),
        sums
    );
}

#[test]
fn head_read_cost_for_one_thousand_summaries() {
    let (mut state, _) = rendered(false, true, false);
    let old = state.offered.take().unwrap();
    let summaries = (1..=1000)
        .map(|sequence| StoredCompartment {
            sequence,
            start_message: sequence * 2,
            end_message: sequence * 2 + 1,
            title: format!("Work {sequence}"),
            content: "Preserved the request prefix and verified the change.".into(),
            importance: 90,
            ..Default::default()
        })
        .collect::<Vec<_>>();
    let inputs = Inputs {
        counter: old.counter,
        summaries: &summaries,
        docs: "",
        profile: &[],
        profile_max_id: 0,
        memories: &[],
        workspace: None,
        gone: &[],
        history_budget_tokens: 1_000_000,
        history_local_budget_tokens: 1_000_000,
        memory_budget_tokens: 4000,
        profile_budget_tokens: 1000,
    };
    let baseline = fold(&inputs, None);
    assert_eq!(baseline.summary_items.len(), 1000);
    let (m1, baseline, _) = delta(&baseline, &inputs);
    let view = View::seal(
        9,
        head_ops(&baseline.m0, &m1, None)
            .into_iter()
            .map(|op| Edit::new(9, op))
            .collect(),
    );
    state.record(&view, Some(Arc::new(baseline)), "provider/model");
    let snapshot = snapshot();
    let started = std::time::Instant::now();
    let result = read(&snapshot, Some(&state)).unwrap();
    let bytes = super::super::result_bytes(result);
    println!(
        "context.head 1000 summaries: {} us, {} reply bytes",
        started.elapsed().as_micros(),
        bytes.len()
    );
}
