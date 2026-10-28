//! Exact Broca fallback captures at the session-reader boundaries.
use super::*;
use crate::providers::async_provider::offline_first_pass as offline;
use crate::session_resolver::ProviderRunner as _;

const SAMPLES: &[(&str, &[u8], &str)] = &[
    (
        "read.default",
        include_bytes!("../../../../testdata/broca-provider-fallback/session.read.default.json"),
        "3ede9b12bf0fb4f15445a9bb3775ea9a6d276b51bac5351e3ba9093fd6e29167",
    ),
    (
        "read.descriptors",
        include_bytes!(
            "../../../../testdata/broca-provider-fallback/session.read.descriptors.json"
        ),
        "495288826d75616b8469639618b8132d6b5ba1105220b21cd8717122ce1b3bf3",
    ),
    (
        "history.default",
        include_bytes!("../../../../testdata/broca-provider-fallback/session.history.default.json"),
        "1ef7fe968a85161b222a6636b162bb0806c226ea9a7d6dbef98e98aa3052d2d9",
    ),
];

fn page(bytes: &[u8]) -> Value {
    session_resolver::read_runner_reply(serde_json::from_slice(bytes).unwrap()).unwrap()
}
fn entries(bytes: &[u8]) -> Vec<ReadMessage> {
    decode(&page(bytes)["messages"]).unwrap()
}
fn ingress(bytes: &[u8]) -> Vec<ck_wire::CkIngressMessage> {
    entries(bytes)
        .iter()
        .map(|e| {
            decoded_entry(
                codec::Codec::OwnedBroca,
                &InboundMessage {
                    ordinal: e.ordinal,
                    mid: e.mid.clone(),
                    message: e.message.clone(),
                },
            )
            .unwrap()
        })
        .collect()
}
async fn rig(dir: &Path) -> Rig {
    Rig::open(
        dir,
        "thalamus-harness",
        "opencode",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await
}

#[test]
fn broca_provider_fallback_envelopes_and_checksums() {
    for (name, bytes, hash) in SAMPLES {
        assert_eq!(crate::sha256_hex(bytes), *hash, "{name}");
        assert_eq!(entries(bytes).len(), 4, "{name}");
    }
}

#[test]
fn broca_provider_fallback_descriptor_rows() {
    for (name, bytes, _) in SAMPLES {
        for e in entries(bytes) {
            let checked = e.check_descriptor_rows(codec::Codec::OwnedBroca.wire_id());
            if *name == "read.descriptors" {
                checked.unwrap();
                check_served_identity(&e, codec::Codec::OwnedBroca).unwrap();
            } else {
                assert!(checked.is_err(), "inline rows are not descriptors: {name}");
                if e.ordinal == 0 {
                    eprintln!("{name}: descriptor-only check: {}", checked.unwrap_err());
                }
            }
        }
    }
}

#[test]
fn broca_provider_fallback_native_round_trip() {
    let mut failures = Vec::new();
    for (name, bytes, _) in SAMPLES {
        let original: Value = serde_json::from_slice(bytes).unwrap();
        let mut wire = original.clone();
        for e in entries(bytes) {
            let inbound = InboundMessage {
                ordinal: e.ordinal,
                mid: e.mid.clone(),
                message: e.message.clone(),
            };
            match decoded_entry(codec::Codec::OwnedBroca, &inbound) {
                Ok(decoded) => {
                    let encoded = codec::encode_message(&decoded.ck).unwrap();
                    assert_eq!(
                        serde_json::to_vec(&encoded).unwrap(),
                        serde_json::to_vec(&e.message).unwrap(),
                        "{name}: message bytes"
                    );
                    assert_eq!(
                        encoded["content"][1].get("raw"),
                        e.message["content"][1].get("raw")
                    );
                    if e.ordinal == 1 {
                        assert_eq!(encoded["content"][1]["raw"].as_str().unwrap().as_bytes(), br#"{"type":"fallback","from":{"model":"claude-opus-5-5"},"to":{"model":"claude-opus-4-8"},"trigger":{"type":"refusal","category":"cyber"}}"#);
                    }
                    wire["result"]["messages"][e.ordinal as usize]["message"] = encoded;
                }
                Err(error) => failures.push(format!("{name}: {error:?}")),
            }
        }
        assert_eq!(wire, original, "{name}: complete native capture");
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn broca_provider_fallback_resumable_read() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let page = page(SAMPLES[1].1);
    *rig.runner.entries.lock().unwrap() = entries(SAMPLES[1].1);
    *rig.runner.page_override.lock().unwrap() = Some(page.clone());
    let mut state = rig.state();
    state.lineage = Some(page["lineage_id"].as_str().unwrap().into());
    let result = rig
        .h
        .read_async_resumable(&mut state, 0, Duration::from_secs(5))
        .await;
    if let Err(error) = &result {
        panic!("resumable read: {error:?}");
    }
    assert!(matches!(result, Ok(ReadProgress::Complete)));
    assert_eq!(state.entries.len(), 4);
}

#[tokio::test]
async fn broca_provider_fallback_notice_ingest_tags_and_summarizer() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let page = page(SAMPLES[1].1);
    *rig.runner.entries.lock().unwrap() = entries(SAMPLES[1].1);
    *rig.runner.page_override.lock().unwrap() = Some(page.clone());
    *rig.runner.lineage.lock().unwrap() = page["lineage_id"].as_str().unwrap().into();
    // Setup precedes the captured lineage in this rig; bind it before notice ingest.
    let mut state = rig.state();
    state.lineage = Some(page["lineage_id"].as_str().unwrap().into());
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    assert!(
        !state.resync && !state.engine_failed && state.failure.is_none(),
        "{:?}",
        state.failure
    );
    assert_eq!(state.completed_seq, 1);
    assert_eq!(state.entries.len(), 4);
    assert!(tag_rows(&state, codec::Codec::OwnedBroca)
        .unwrap()
        .is_empty());
    assert!(state.tag_index.is_empty());
    let store = rig.h.store.get().unwrap();
    assert!(store
        .load_tags_for_session(&state.namespace())
        .unwrap()
        .is_empty());
    let mut request = rig.h.async_historian_request(&state).unwrap();
    let mut index = historian_tail::InputIndex::default();
    for entry in state.entries.values() {
        index.add(&decoded_entry(codec::Codec::OwnedBroca, &entry.inbound().unwrap()).unwrap());
    }
    historian_tail::prepare_input(
        store,
        &state.reference(),
        index.window(None).through(Some(3)),
        codec::Codec::OwnedBroca,
        &mut request,
        &state.reminder_echoes,
    )
    .unwrap();
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    let rendered = crate::historian_chunk::build_historian_chunk(
        &request.messages,
        &projection.blocks,
        0,
        100_000,
        4,
    )
    .text;
    assert!(!rendered.contains("claude-opus") && !rendered.contains("provider_fallback"));
}

#[test]
fn broca_provider_fallback_tool_arcs_and_positions() {
    for (_, bytes, _) in SAMPLES {
        let es = entries(bytes);
        let decoded = ingress(bytes);
        assert_eq!(decoded[1].ck.content.len(), 4);
        assert!(matches!(
            decoded[1].ck.content[0].kind,
            ck_wire::CkKind::Reasoning { .. }
        ));
        assert!(matches!(
            decoded[1].ck.content[1].kind,
            ck_wire::CkKind::Opaque(_)
        ));
        assert!(matches!(
            decoded[1].ck.content[2].kind,
            ck_wire::CkKind::Reasoning { .. }
        ));
        assert!(matches!(
            decoded[1].ck.content[3].kind,
            ck_wire::CkKind::ToolCall { .. }
        ));
        assert_eq!(
            es[1]
                .tags
                .iter()
                .map(|t| t.part.as_str())
                .collect::<Vec<_>>(),
            ["m1#0", "m1#1", "m1#2", "m1#3"]
        );
        assert!(es.iter().flat_map(|e| &e.tags).all(|t| t.tag.is_none()));
        let kept = tool_arcs::KeptMessage::new(codec::Codec::OwnedBroca, &es[1]).unwrap();
        assert_eq!(kept.parts, ["m1#0", "m1#1", "m1#2", "m1#3"]);
        assert_eq!(
            es[1].tool_calls[0].call_key.as_deref(),
            Some("8fca05fd-2e42-4be6-96a7-8638ac7ea530:5")
        );
        let projection = ck_wire::project_messages(&decoded).unwrap();
        let call = projection.blocks.iter().find(|b| b.id == "m1#3").unwrap();
        let result = projection.blocks.iter().find(|b| b.id == "m2#0").unwrap();
        assert_eq!(call.arc_id, result.arc_id);
        let fallback = projection.blocks.iter().find(|b| b.id == "m1#1").unwrap();
        assert!(fallback.arc_id.is_none());
        assert!(fallback.scalar_text().is_none());
        let rendered = crate::historian_chunk::build_historian_chunk(
            &decoded,
            &projection.blocks,
            0,
            100_000,
            4,
        )
        .text;
        assert!(!rendered.contains("provider_fallback") && !rendered.contains("claude-opus"));
    }
}

#[tokio::test]
async fn broca_provider_fallback_offline_import_and_first_pass() {
    let dir = tempfile::tempdir().unwrap();
    let answer = page(SAMPLES[1].1);
    let lineage = answer["lineage_id"].as_str().unwrap();
    // Offline exports contain the page directly, without the response's `result` wrapper.
    let pages = crate::offline_first_pass::parse_pages(
        std::io::Cursor::new(answer.to_string()),
        codec::Codec::OwnedBroca,
    )
    .unwrap();
    assert_eq!(pages.entries, 4);
    assert!(pages.lowest_tag.is_none());
    let describe = Runner::default()
        .call(
            dir.path(),
            "s",
            "role.describe",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    let setup = offline::OfflineSetup {
        project_root: dir.path().into(), runner_module: "broca".into(), runner_describe: describe.clone(),
        request: decode(&json!({"session":"s","harness":"broca","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":false},"params":{"serializer_profile":"owned-broca"},"lineage_id":lineage,"now":1})).unwrap(),
    };
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    };
    let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
    let mut h = McHandler::new();
    h.producer_factory =
        crate::providers::session_runner_fake::FakeSessionRunner::for_project(dir.path()).factory();
    h.fixed_config = Some(McModuleConfig {
        inject_docs: false,
        protected_tokens_user: Some(0),
        protected_tools: BTreeMap::new(),
        ..Default::default()
    });
    h.store.set(store.clone()).ok().unwrap();
    h.provider_runner = Arc::new(offline::PagesRunner::new(pages.served, describe));
    let outcome = h.offline_first_pass(&setup).await.unwrap();
    let offline::OfflineOutcome::Prepared(report) = outcome else {
        panic!("expected first pass: {outcome:?}")
    };
    assert_eq!(report.proof.count, 4);
    let state = load(&store, &report.reference).unwrap().unwrap();
    assert_eq!(state.entries.len(), 4);
    assert!(state.tag_index.is_empty());
    assert!(state.failure.is_none() && !state.engine_failed && !state.resync);
}

#[tokio::test]
async fn broca_provider_fallback_ctx_expand_history() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig(dir.path()).await;
    let answer = page(SAMPLES[2].1);
    *rig.runner.history_override.lock().unwrap() = Some(answer.clone());
    let mut state = rig.state();
    state.lineage = Some(answer["lineage_id"].as_str().unwrap().into());
    state.lineage_first_ordinal = 4;
    state.save(rig.h.store.get().unwrap(), &[]).unwrap();
    let summary = mc_store::StoredCompartment {
        start_message: 0,
        end_message: 3,
        start_message_id: "m0".into(),
        end_message_id: "m3#0".into(),
        ..Default::default()
    };
    let binding = rig.h.facade_binding(7).unwrap();
    let recovered = rig
        .h
        .async_history_expand(&binding, &state.namespace(), &[summary], 0, 3)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered.len(), 4);
    let text = crate::render_durable_range_expand(0, 3, &recovered);
    assert!(text.contains("done"));
    assert!(!text.contains("provider_fallback") && !text.contains("claude-opus"));
}

#[test]
fn broca_provider_fallback_view_edits() {
    for (_, bytes, _) in SAMPLES {
        let source = ingress(bytes).remove(1).ck;
        let original = codec::encode_message(&source).unwrap();
        let mut kept = source.clone();
        if let ck_wire::CkKind::ToolCall { input, .. } = &mut kept.content[3].kind {
            *input = json!({"edited":true});
        }
        let edited = codec::encode_message(&kept).unwrap();
        assert_eq!(edited["content"][1], original["content"][1]);
        for index in [0, 1, 2] {
            let mut dropped = source.clone();
            dropped.content.remove(index);
            let refusal = codec::encode_message(&dropped).unwrap_err();
            assert!(
                matches!(refusal, HandlerOutcome::Error { code, .. } if code == "provider_fallback_edit_unsupported")
            );
        }
    }
}

#[test]
fn broca_provider_fallback_final_keep_edits_are_checked() {
    for (_, bytes, _) in SAMPLES {
        let kept: tool_arcs::KeptMessages = entries(bytes)
            .iter()
            .map(|entry| {
                (
                    entry.ordinal,
                    tool_arcs::KeptMessage::new(codec::Codec::OwnedBroca, entry).unwrap(),
                )
            })
            .collect();
        let make_view = |ranges| {
            view::CompactionView::new(
                "00000000000000000000000000000000",
                1,
                "L",
                compact::lineage::MessageRef {
                    ordinal: 3,
                    mid: "m3".into(),
                },
                ranges,
            )
        };
        let intact = make_view(vec![view::ViewRange::keep_with_edits(0, 4, vec![])]);
        assert!(checked_async_view(intact, codec::Codec::OwnedBroca, &kept)
            .unwrap()
            .is_ok());
        for part in ["m1#0", "m1#1", "m1#2"] {
            let candidate = make_view(vec![view::ViewRange::keep_with_edits(
                0,
                4,
                vec![view::PartEdit::drop(1, "m1", part)],
            )]);
            let refusal =
                checked_async_view(candidate, codec::Codec::OwnedBroca, &kept).unwrap_err();
            assert!(
                matches!(refusal, HandlerOutcome::Error { code, .. } if code == "provider_fallback_edit_unsupported")
            );
        }
        let removed = make_view(vec![view::ViewRange::replace(0, 4, "[]")]);
        assert!(checked_async_view(removed, codec::Codec::OwnedBroca, &kept)
            .unwrap()
            .is_ok());
    }
}

#[tokio::test]
async fn broca_provider_fallback_each_sample_ingests_without_allocating_tags() {
    let mut failures = Vec::new();
    for (name, bytes, _) in SAMPLES {
        let dir = tempfile::tempdir().unwrap();
        let rig = rig(dir.path()).await;
        let mut state = rig.state();
        for entry in entries(bytes) {
            state.entries.insert(
                entry.ordinal,
                Arc::new(HeldEntry::from_read(&entry).unwrap()),
            );
        }
        match state.ingest_read(rig.h.store.get().unwrap(), codec::Codec::OwnedBroca) {
            Ok(()) => {
                assert!(state.tag_index.is_empty());
                assert!(tag_rows(&state, codec::Codec::OwnedBroca)
                    .unwrap()
                    .is_empty());
                assert_eq!(rig.state().entries.len(), 4);
            }
            Err(error) => failures.push(format!("{name}: {error:?}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
