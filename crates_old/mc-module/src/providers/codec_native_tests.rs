//! OpenCode and Pi schemas through the shared provider codec, as a runner
//! hands them over: one native entry at a time, keyed by its own id.
use super::codec::Codec;
use super::*;

type NativeId = fn(&Value) -> Option<&str>;

fn opencode_id(message: &Value) -> Option<&str> {
    message.pointer("/info/id").and_then(Value::as_str)
}

fn pi_id(message: &Value) -> Option<&str> {
    message.get("id").and_then(Value::as_str)
}

/// The committed native fixtures (captured from real OpenCode and Pi
/// sessions; their TypeScript generators carry the `--check` drift guard),
/// restricted to the entries a runner serves: messages keyed by their id.
fn fixture_entries(profile: &str) -> Vec<codec::InboundMessage> {
    let (raw, field, id): (&str, &str, NativeId) = match profile {
        "opencode-aisdk" => (
            include_str!("../../testdata/codec/opencode-golden.json"),
            "messages",
            opencode_id,
        ),
        _ => (
            include_str!("../../testdata/codec/pi-golden.json"),
            "entries",
            pi_id,
        ),
    };
    let golden: Value = serde_json::from_str(raw).unwrap();
    golden["cases"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|case| case[field].as_array().unwrap().iter())
        .filter(|native| profile != "pi" || native["type"] == "message")
        .enumerate()
        .map(|(ordinal, native)| codec::InboundMessage {
            mid: id(native).expect("fixture message id").into(),
            ordinal: ordinal as u64,
            message: native.clone(),
        })
        .collect()
}

#[test]
fn native_decode_then_encode_round_trips_each_schema_byte_identically() {
    for profile in ["opencode-aisdk", "pi"] {
        let entries = fixture_entries(profile);
        assert!(entries.len() >= 8, "{profile} fixture lost its coverage");
        let codec = Codec::from_params(&json!({"serializer_profile":profile})).unwrap();
        assert_eq!(codec.serializer_profile().wire_id(), profile);
        // Decode one entry at a time, as a runner's transcript is ingested.
        let replacement = codec
            .decode_entries(&entries)
            .unwrap()
            .into_iter()
            .map(|ingress| ingress.ck)
            .collect();
        let view = transform::compaction::View {
            compaction_id: "compact".into(),
            version: 3,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 0,
                to: entries.len() as u64,
            },
            replacement,
        };
        let wire = codec
            .render_view(&view, "runner-session", &entries)
            .unwrap();
        assert_eq!(
            bytes(&wire.replacement).unwrap(),
            bytes(
                &entries
                    .iter()
                    .map(|entry| &entry.message)
                    .collect::<Vec<_>>()
            )
            .unwrap(),
            "{profile}"
        );
    }
}

/// A runner's entries are decoded and cached one at a time, while a host-lane
/// request decodes the whole array at once. Both must see the same messages.
#[test]
fn native_entry_decode_matches_whole_array_decode() {
    for profile in ["opencode-aisdk", "pi"] {
        let entries = fixture_entries(profile);
        let codec = Codec::from_params(&json!({"serializer_profile":profile})).unwrap();
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
            "serializer_profile":profile,"session_id":"runner-session","render_config":"","messages":[],
            "tool_present":false,"auto_search_enabled":false}))
        .unwrap();
        codec.prepare_request(&mut request, &entries).unwrap();
        assert_eq!(request.messages.len(), entries.len());
        for (entry, whole) in entries.iter().zip(&request.messages) {
            let single = codec.decode_message(entry).unwrap();
            assert_eq!(single.mid, whole.mid);
            assert_eq!(single.ordinal, whole.ordinal);
            assert_eq!(
                single.ck.to_canonical_json_vec().unwrap(),
                whole.ck.to_canonical_json_vec().unwrap(),
                "{profile} {}",
                entry.mid
            );
        }
    }
}

#[test]
fn runner_profiles_select_their_codec_and_the_gateway_profile_is_unknown() {
    for (params, expected) in [
        (json!({}), Codec::OwnedBroca),
        (
            json!({"serializer_profile":"owned-broca"}),
            Codec::OwnedBroca,
        ),
        (
            json!({"serializer_profile":"opencode-aisdk"}),
            Codec::OpencodeAiSdk,
        ),
        (json!({"serializer_profile":"pi"}), Codec::Pi),
        (
            json!({"serializer_profile":"anthropic-messages"}),
            Codec::AnthropicMessages,
        ),
    ] {
        assert_eq!(Codec::from_params(&params).unwrap(), expected);
    }
    match Codec::from_params(&json!({"serializer_profile":"claude-code-anthropic"})) {
        Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) => {
            assert_eq!(code, "invalid_params");
            assert_eq!(detail, json!({"field":"params.serializer_profile"}));
        }
        other => panic!("gateway profile admitted: {other:?}"),
    }
}

/// Broca's messages carry their own native copy, so its rendering ignores the
/// session and entries and equals the plain Broca encoder.
#[test]
fn broca_render_matches_its_encoder() {
    let entries: Vec<codec::InboundMessage> = serde_json::from_str(include_str!(
        "../tests/fixtures/tool-catalog/broca-session-read-messages.json"
    ))
    .unwrap();
    let replacement = Codec::OwnedBroca
        .decode_entries(&entries)
        .unwrap()
        .into_iter()
        .map(|ingress| ingress.ck)
        .collect();
    let view = transform::compaction::View {
        compaction_id: "compact".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: entries.len() as u64,
        },
        replacement,
    };
    let rendered = Codec::OwnedBroca
        .render_view(&view, "ignored", &[])
        .unwrap();
    assert_eq!(rendered, codec::encode_view(&view).unwrap());
    assert_eq!(
        bytes(&rendered.replacement).unwrap(),
        bytes(&entries.iter().map(|e| &e.message).collect::<Vec<_>>()).unwrap()
    );
}

#[test]
fn an_opencode_entry_without_its_id_is_refused_not_guessed() {
    let mut entry = fixture_entries("opencode-aisdk").remove(0);
    entry.mid = "another-id".into();
    assert!(Codec::OpencodeAiSdk.decode_message(&entry).is_err());
    let mut entry = fixture_entries("pi").remove(0);
    entry.message.as_object_mut().unwrap().remove("id");
    assert!(Codec::Pi.decode_message(&entry).is_err());
}
