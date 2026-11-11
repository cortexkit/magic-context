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

fn with_other(mut state: ReadState) -> ReadState {
    let previous = state.offered.take().unwrap();
    let m0 = format!(
        "{}\n\n<future-block>Unrecognized but preserved.</future-block>",
        previous.slots[0].text
    );
    let mut baseline = previous.baseline.as_ref().unwrap().as_ref().clone();
    baseline.m0 = m0.clone();
    let view = View::seal(
        8,
        head_ops(
            &m0,
            &previous.slots[1].text,
            previous.slots[0].image.clone(),
        )
        .into_iter()
        .map(|op| Edit::new(8, op))
        .collect(),
    );
    state.record(&view, Some(Arc::new(baseline)), "provider/model");
    state.confirm(8);
    state
}

fn shared_block(content: &str, duplicate: bool) -> String {
    let workspace = crate::workspace::Workspace {
        own: "own".into(),
        members: vec!["own".into(), "shared".into()],
        names: BTreeMap::from([("shared".into(), "Related & project".into())]),
        canonical: BTreeMap::from([
            ("own".into(), "own".into()),
            ("shared".into(), "shared".into()),
        ]),
        ..Default::default()
    };
    let memories = [
        StoredMemory {
            id: 1,
            project_path: "own".into(),
            category: "PROJECT_RULES".into(),
            content: "Keep the prefix stable.\nCheck the original bytes.".into(),
            ..Default::default()
        },
        StoredMemory {
            id: if duplicate { 1 } else { 2 },
            project_path: "shared".into(),
            category: "PROJECT_RULES".into(),
            content: content.into(),
            ..Default::default()
        },
    ];
    crate::memory::render_workspace_block(&memories, "project-memory", Some(&workspace))
}

fn with_memory_block(mut state: ReadState, block: &str) -> ReadState {
    let previous = state.offered.take().unwrap();
    let m0 = split(&previous.slots[0].text, false)
        .unwrap()
        .iter()
        .map(|(kind, text)| if *kind == "memory" { block } else { text })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut baseline = previous.baseline.as_ref().unwrap().as_ref().clone();
    baseline.m0 = m0.clone();
    let view = View::seal(
        9,
        head_ops(
            &m0,
            &previous.slots[1].text,
            previous.slots[0].image.clone(),
        )
        .into_iter()
        .map(|op| Edit::new(9, op))
        .collect(),
    );
    state.record(&view, Some(Arc::new(baseline)), "provider/model");
    state.confirm(9);
    state
}

#[test]
fn shared_memory_items_name_sources_but_omit_ambiguous_boundaries() {
    for (content, duplicate, known) in [
        ("Use shared constraints.", false, true),
        (
            "Use shared constraints.\nA plain continuation.",
            false,
            false,
        ),
        ("Use shared constraints.", true, false),
    ] {
        let block = shared_block(content, duplicate);
        let state = with_memory_block(rendered(false, true, false).0, &block);
        let result = read(&snapshot(), Some(&state)).unwrap();
        let section = result["messages"][0]["sections"]
            .as_array()
            .unwrap()
            .iter()
            .find(|section| section["kind"] == "memory")
            .unwrap();
        assert_eq!(section["text"], block);
        if known {
            let items = section["items"].as_array().unwrap();
            assert_eq!(items.len(), 2);
            assert!(items[0].get("source").is_none());
            assert!(items[0]["text"]
                .as_str()
                .unwrap()
                .contains("\n  Check the original bytes."));
            assert_eq!(items[1]["source"], "Related & project");
            assert_eq!(items[1]["id"], 2);
        } else {
            assert!(section.get("items").is_none());
        }
    }
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
fn unrecognized_sections_preserve_bytes_warn_once_and_release_with_the_head() {
    let state = with_other(rendered(true, false, false).0);
    let expected = state.offered.as_ref().unwrap().slots[0].text.clone();
    let weak = Arc::downgrade(state.offered.as_ref().unwrap());
    let mut replica = super::super::tests::replica(None);
    let key = replica.snapshots.keys().next().unwrap().clone();
    replica.heads.insert(key.clone(), state);
    for _ in 0..2 {
        let result = replica
            .read("context.head", &json!({"session":key}))
            .unwrap();
        let message = &result["messages"][0];
        assert_eq!(reconstruct(message), expected);
        let other = message["sections"].as_array().unwrap().last().unwrap();
        assert_eq!(other["kind"], "other");
        assert!(other.get("items").is_none());
    }
    assert_eq!(replica.head_warnings.borrow().len(), 1);
    replica.forget_head(&key);
    assert!(replica.heads.is_empty());
    assert!(replica.head_warnings.borrow().is_empty());
    assert!(weak.upgrade().is_none());
    assert!(
        replica.snapshots.contains_key(&key),
        "historical projections retain their existing lifetime"
    );
}

#[test]
fn malformed_or_reordered_sections_remain_lossless_but_invalid_delta_envelopes_refuse() {
    for text in [
        "<user-profile>x</user-profile>\n\n<project-docs>later</project-docs>",
        "<session-history>missing close",
        "<session-history></session-history>attached",
        "<session-history></session-history>\n\n",
    ] {
        let parts = split(text, false).unwrap();
        assert_eq!(
            parts
                .iter()
                .map(|(_, text)| *text)
                .collect::<Vec<_>>()
                .join("\n\n"),
            text
        );
        assert_eq!(parts.last().unwrap().0, "other");
    }
    let delta = "<session-history-since>\n<new-block>kept</new-block>\n</session-history-since>";
    assert_eq!(
        split(delta, true).unwrap(),
        vec![("other", "<new-block>kept</new-block>")]
    );
    assert!(split("not a delta envelope", true).is_err());
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
        "head-other",
        "head-shared",
    ] {
        let (mut state, _) = rendered(
            name != "head-no-mural",
            name == "head-empty-delta",
            name == "head-no-items",
        );
        if name == "head-other" {
            state = with_other(state);
        }
        if name == "head-shared" {
            state = with_memory_block(state, &shared_block("Use shared constraints.", false));
        }
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

fn large_head(memory_count: i64, image: Option<InsertedImage>) -> (View, Arc<Baseline>) {
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
    let memories = (1..=memory_count)
        .map(|id| StoredMemory {
            id,
            category: "PROJECT_RULES".into(),
            content: format!("Verified memory {id}: preserve the cached request prefix."),
            importance: Some(90),
            status: "active".into(),
            ..Default::default()
        })
        .collect::<Vec<_>>();
    let inputs = Inputs {
        counter: Counter::for_model(Some("provider/model")),
        summaries: &summaries,
        docs: "",
        profile: &[],
        profile_max_id: 0,
        memories: &memories,
        workspace: None,
        gone: &[],
        history_budget_tokens: 1_000_000,
        history_local_budget_tokens: 1_000_000,
        memory_budget_tokens: 1_000_000,
        profile_budget_tokens: 1000,
    };
    let baseline = fold(&inputs, image.as_ref().map(|_| "tiny-mural"));
    assert_eq!(baseline.summary_items.len(), 1000);
    assert_eq!(baseline.shown.len(), memory_count as usize);
    let (m1, baseline, _) = delta(&baseline, &inputs);
    let view = View::seal(
        9,
        head_ops(&baseline.m0, &m1, image)
            .into_iter()
            .map(|op| Edit::new(9, op))
            .collect(),
    );
    (view, Arc::new(baseline))
}

#[test]
fn head_read_cost_for_one_thousand_summaries() {
    let (view, baseline) = large_head(0, None);
    let mut state = ReadState::default();
    state.record(&view, Some(baseline), "provider/model");
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

#[test]
fn head_resident_cost_shares_one_thousand_summary_and_two_thousand_memory_records() {
    let image = rendered(true, true, false)
        .0
        .offered
        .as_ref()
        .unwrap()
        .slots[0]
        .image
        .clone();
    let (view, baseline) = large_head(2000, image);
    let mut state = ReadState::default();
    let started = std::time::Instant::now();
    state.record(&view, Some(baseline.clone()), "provider/model");
    let capture_us = started.elapsed().as_micros();
    let head = state.offered.as_ref().unwrap();
    assert!(Arc::ptr_eq(head.baseline.as_ref().unwrap(), &baseline));
    let payload = head
        .slots
        .iter()
        .map(|slot| slot.text.len() + slot.image.as_ref().map_or(0, |image| image.data.len()))
        .sum::<usize>();
    let arc_header = 2 * std::mem::size_of::<usize>();
    let owned = std::mem::size_of::<ReadState>()
        + std::mem::size_of::<Head>()
        + arc_header
        + head.slots.capacity() * std::mem::size_of::<Arc<Slot>>()
        + head
            .slots
            .iter()
            .map(|slot| {
                std::mem::size_of::<Slot>()
                    + arc_header
                    + slot.id.capacity()
                    + slot.text.capacity()
                    + slot.image.as_ref().map_or(0, |image| {
                        image.media_type.capacity() + image.data.capacity()
                    })
            })
            .sum::<usize>();
    let rss = || {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|text| {
                text.lines().find_map(|line| {
                    line.strip_prefix("VmRSS:")
                        .and_then(|value| value.split_whitespace().next())
                        .and_then(|value| value.parse::<usize>().ok())
                        .map(|kib| kib * 1024)
                })
            })
    };
    let before = rss();
    let residents = (0..64)
        .map(|_| {
            let mut state = ReadState::default();
            state.record(&view, Some(baseline.clone()), "provider/model");
            state
        })
        .collect::<Vec<_>>();
    let resident_per_head = before
        .zip(rss())
        .map(|(before, after)| after.saturating_sub(before) / residents.len());
    println!("context.head 1000 summaries + 2000 memories + tiny mural: capture {capture_us} us; owned payload {payload} bytes; allocations including structures {owned} bytes (allocator bookkeeping excluded); measured incremental RSS/head over 64 captures: {resident_per_head:?} bytes");
    assert_eq!(residents.len(), 64);
}
