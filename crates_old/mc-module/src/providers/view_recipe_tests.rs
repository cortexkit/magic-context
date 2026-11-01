//! Pure recipe round-trip coverage.
use super::*;

/// A Pi view saved
/// through the recipe store is byte-identical to the view that was saved, with
/// across successive versions. Every message is stored whole: the Pi codec streams
/// no native range and applies no patch.
#[test]
fn v2_pi_recipe_round_trips_the_whole_host_view() {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let key = Key {
        runner: "thalamus-harness".into(),
        session: "pi-session".into(),
        harness: "pi".into(),
    };
    store
        .save_provider_conversation(
            &key.store_key(),
            &mc_store::provider_records::ProviderConversation {
                engine_namespace: "pi-session".into(),
                params_json: r#"{"serializer_profile":"pi","observation":"answer"}"#.into(),
                hook_counters_json: "{}".into(),
                historian_model_chain_json: "[]".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let entries: Vec<_> = [
        json!({"id":"u1","type":"message","parentId":null,"message":{"role":"user","timestamp":1,"content":[{"type":"text","text":"café \"quoted\"\n"}]}}),
        json!({"id":"a1","type":"message","parentId":"u1","message":{"role":"assistant","timestamp":2,"responseId":"r1","content":[{"type":"text","text":"雪 answer","textSignature":"sig"}]}}),
        json!({"id":"u2","type":"message","parentId":"a1","message":{"role":"user","timestamp":3,"content":[{"type":"text","text":"live tail"}]}}),
    ]
    .into_iter()
    .enumerate()
    .map(|(ordinal, message)| codec::InboundMessage {

        mid: message["id"].as_str().unwrap().into(),
        ordinal: ordinal as u64,
        message,
    })
    .collect();
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"pi","session_id":"pi-session","render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false})).unwrap();
    Codec::Pi.prepare_request(&mut request, &entries).unwrap();
    let engine = transform::compaction::View {
        compaction_id: "c".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: entries.len() as u64,
        },
        // A synthetic summary head followed by the retained journal messages.
        replacement: std::iter::once(ck_wire::CkWireMessage::synthetic_user_text(
            "summary head".to_string(),
        ))
        .chain(
            request
                .messages
                .iter()
                .skip(1)
                .map(|entry| entry.ck.clone()),
        )
        .collect(),
    };
    let wire = super::codec_pi::encode_view(&engine, &request).unwrap();
    let plain = compaction::EngineView { engine, wire };
    let mut cut = plain.clone();
    cut.engine.version = 2;
    cut.wire = super::codec_pi::encode_view(&cut.engine, &request).unwrap();
    for host in [&plain, &cut] {
        let version = host.engine.version;
        save_host(&store, &key, host, "produced").unwrap();
        let resolved = store
            .resolve_provider_view_catalog(&key.store_key(), version)
            .unwrap()
            .unwrap();
        assert_eq!(resolved.recipe.serializer_profile, "pi");
        assert_eq!(resolved.recipe.render_key, "provider-pi-whole-v1");
        assert!(resolved.recipe.treatments.is_empty());
        assert!(!resolved
            .recipe
            .segments
            .iter()
            .any(|segment| matches!(segment, ProviderViewSegment::NativeRange { .. })));
        let loaded = load(&store, &key, version).unwrap().unwrap();
        // The wire view (the Pi journal entries the module sends back to the Pi
        // harness) is byte-identical to what was saved.
        assert_eq!(
            serde_json::to_string(&loaded.wire).unwrap(),
            serde_json::to_string(&host.wire).unwrap()
        );
        // The whole view equals the saved one. Engine messages hold JSON maps that
        // serde_json re-reads in sorted key order, so compare against the same
        // JSON round trip the retired whole-copy table applied when it was read.
        let reread: compaction::EngineView =
            serde_json::from_str(&serde_json::to_string(host).unwrap()).unwrap();
        let expected = serde_json::to_string(&reread).unwrap();
        assert_eq!(serde_json::to_string(&loaded).unwrap(), expected);
        assert_eq!(
            serde_json::to_value(&loaded).unwrap(),
            serde_json::to_value(host).unwrap()
        );
        let stored = stored_view(&store, &key.store_key(), version).unwrap();
        assert_eq!(stored.replacement_json, expected);
    }
    // Both versions stay readable side by side.
    assert_eq!(stored_views(&store, &key.store_key()).len(), 2);
}
