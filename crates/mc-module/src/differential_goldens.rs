//! DG-1..6 differential goldens: TS emits fixtures, Rust consumes them in-process.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::ck_wire::{CkIngressMessage, CkWireMessage};
use crate::healing::SerializerProfile;
use crate::transform::{
    apply_frozen_trailing_blank_decision, is_newest_synthetic_user_prompt,
    user_terminated_tail_decision, TransformRequest, TransformResponse, UserTerminatedTailDecision,
};
use mc_core::{CoreState, DurabilityClass, FrozenUnit};

use super::{attach_native_messages_incremental, NativeAttachmentCache, NativeCacheKeyMode};

#[derive(Debug, Deserialize)]
struct Golden {
    schema: u32,
    provenance: Provenance,
    cases: Vec<GoldenCase>,
}

#[derive(Debug, Deserialize)]
struct Provenance {
    generator_version: String,
    input_sha256: String,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    id: String,
    family: String,
    input: Value,
    expected: Expected,
}

#[derive(Debug, Deserialize)]
struct Expected {
    status: String,
    action: String,
    decision: String,
    wire: Vec<Value>,
}

fn rust_wire_for_case(case: &GoldenCase, input_wire: &[Value]) -> Vec<Value> {
    let mut messages: Vec<CkWireMessage> =
        serde_json::from_value(Value::Array(input_wire.to_vec())).expect("canonical DG CK wire");
    if matches!(
        case.family.as_str(),
        "user-terminated-tail" | "newest-synthetic-user"
    ) {
        let ingress = messages
            .iter()
            .enumerate()
            .map(|(index, message)| CkIngressMessage {
                mid: message
                    .meta
                    .harness_id
                    .clone()
                    .unwrap_or_else(|| format!("dg-{index}")),
                ordinal: index as u64 + 1,
                ck: message.clone(),
            })
            .collect::<Vec<_>>();
        let request: TransformRequest = serde_json::from_value(json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "opencode-aisdk",
            "provider_id": "anthropic",
            "session_id": format!("dg-tail-{}", case.id),
            "render_config": "dg",
            "serve_native": true,
            "prev_response_completed_at_ms": 1,
            "messages": ingress,
        }))
        .expect("DG tail request");
        if case.family == "user-terminated-tail" {
            match user_terminated_tail_decision(&request) {
                UserTerminatedTailDecision::Reanchor { user_mid } => {
                    let index = messages
                        .iter()
                        .position(|message| message.meta.harness_id.as_deref() == Some(&user_mid))
                        .expect("DG re-anchor user must be present");
                    let user = messages.remove(index);
                    messages.push(user);
                }
                decision => panic!("unexpected DG tail decision: {decision:?}"),
            }
        } else {
            messages.retain(|message| {
                let mid = message.meta.harness_id.as_deref().unwrap_or_default();
                let ingress = request
                    .messages
                    .iter()
                    .find(|ingress| ingress.mid == mid)
                    .expect("DG message must retain its ingress identity");
                !message.meta.synthetic || is_newest_synthetic_user_prompt(&request, ingress)
            });
        }
    }
    if case.family == "trailing-blank-keep-zero-source" {
        let frozen = &case.input["frozen_decision"];
        let mid = frozen["message_id"]
            .as_str()
            .expect("DG trailing-blank target id");
        assert_eq!(frozen["decision"], "keep");
        let core = CoreState {
            frozen_units: vec![FrozenUnit {
                key: format!("strip:trailing_blank_keep:{mid}"),
                kind: "strip_trailing_blank_keep".to_string(),
                frozen_payload: String::new(),
                durability_class: DurabilityClass::Lineage,
                reset_rule: String::new(),
            }],
            ..Default::default()
        };
        let target = messages
            .iter_mut()
            .find(|message| message.meta.harness_id.as_deref() == Some(mid))
            .expect("DG trailing-blank target must be present");
        apply_frozen_trailing_blank_decision(
            &core,
            SerializerProfile::OpencodeAiSdk,
            Some("anthropic"),
            false,
            mid,
            target,
        );
    }
    messages
        .iter()
        .map(|message| serde_json::to_value(message).expect("serialize CK wire"))
        .collect()
}

#[test]
fn dg_goldens_match_ts_wire_surface_and_gate_labels() {
    let golden: Golden = serde_json::from_str(include_str!("../testdata/differential-golden.json"))
        .expect("parse differential golden");
    assert_eq!(golden.schema, 1);
    assert_eq!(golden.provenance.generator_version, "dg-reference-v4");
    assert_eq!(golden.provenance.input_sha256.len(), 64);
    assert_eq!(golden.cases.len(), 6);

    for case in &golden.cases {
        let input_wire = case.input["messages"]
            .as_array()
            .expect("every DG input has messages");
        let rust_wire = rust_wire_for_case(case, input_wire);
        assert_eq!(rust_wire, case.expected.wire, "wire drift in {}", case.id);
        assert!(!case.family.is_empty());
        assert_eq!(
            case.expected.status, "ok",
            "unexpected status in {}",
            case.id
        );
        assert!(!case.expected.action.is_empty());
        assert!(!case.expected.decision.is_empty());
    }
}

#[test]
fn dg_golden_vacuity_guard_rejects_one_byte_fixture_perturbation_per_family() {
    let golden: Golden = serde_json::from_str(include_str!("../testdata/differential-golden.json"))
        .expect("parse differential golden");
    let mut observed = 0;
    for case in &golden.cases {
        let mut perturbed = case.input["messages"].clone();
        let mut mutated_text = None;
        if let Some(message) = perturbed
            .as_array_mut()
            .and_then(|messages| messages.first_mut())
            .and_then(|message| message.get_mut("content"))
            .and_then(Value::as_array_mut)
            .and_then(|parts| parts.first_mut())
            .and_then(|part| part.get_mut("kind"))
            .and_then(|kind| kind.get_mut("text"))
        {
            if let Some(text) = message.as_str() {
                mutated_text = Some(format!("{text}x"));
                *message = Value::String(mutated_text.clone().expect("mutation text"));
            }
        }
        if mutated_text.is_none() {
            let bytes = serde_json::to_vec(&perturbed).expect("serialize fixture");
            perturbed = Value::String(String::from_utf8_lossy(&bytes).to_string() + "x");
        }
        let perturbed_wire = rust_wire_for_case(
            case,
            perturbed
                .as_array()
                .expect("the one-byte DG perturbation preserves the message array"),
        );
        assert_ne!(
            perturbed_wire, case.expected.wire,
            "{} accepted a one-byte mutation",
            case.id
        );
        observed += 1;
    }
    assert_eq!(observed, 6, "every DG family needs a vacuity mutation");
}

#[test]
fn dg_goldens_exercise_incremental_native_differential_mode() {
    let golden: Golden = serde_json::from_str(include_str!("../testdata/differential-golden.json"))
        .expect("parse differential golden");
    for case in &golden.cases {
        let wire = &case.expected.wire;
        let served: Vec<CkWireMessage> =
            serde_json::from_value(Value::Array(wire.clone())).expect("canonical DG CK wire");
        let ingress = served
            .iter()
            .enumerate()
            .map(|(index, message)| CkIngressMessage {
                mid: message
                    .meta
                    .harness_id
                    .clone()
                    .unwrap_or_else(|| format!("dg-{index}")),
                ordinal: index as u64 + 1,
                ck: message.clone(),
            })
            .collect::<Vec<_>>();
        let request: TransformRequest = serde_json::from_value(json!({
            "kind": "transform",
            "v": 2,
            "serializer_profile": "opencode-aisdk",
            "session_id": format!("dg-native-{}", case.id),
            "render_config": "dg",
            "serve_native": true,
            "messages": ingress,
            "full_array_fingerprint": format!("fp-{}", case.id),
        }))
        .expect("DG native transform request");
        let cache = Mutex::new(NativeAttachmentCache::new(1024 * 1024));
        let mut first =
            TransformResponse::passthrough(served.clone(), request.full_array_fingerprint.clone());
        attach_native_messages_incremental(
            &mut first,
            &request,
            0,
            &BTreeMap::new(),
            None,
            None,
            false,
            None,
            0,
            &cache,
            NativeCacheKeyMode::Normal,
        );
        let mut replay =
            TransformResponse::passthrough(served.clone(), request.full_array_fingerprint.clone());
        let stats = attach_native_messages_incremental(
            &mut replay,
            &request,
            0,
            &BTreeMap::new(),
            None,
            None,
            false,
            None,
            0,
            &cache,
            NativeCacheKeyMode::Normal,
        );
        assert_eq!(
            serde_json::to_vec(&first.native_messages).unwrap(),
            serde_json::to_vec(&replay.native_messages).unwrap(),
            "native replay drift in {}",
            case.id
        );
        assert_eq!(stats.encoded_messages, 0, "{} missed cache", case.id);
        assert_eq!(stats.reused_messages, served.len(), "{} prefix", case.id);

        let mut appended = request.messages.clone();
        appended.push(CkIngressMessage {
            mid: format!("dg-{}-tail", case.id),
            ordinal: appended
                .last()
                .map_or(1, |message| message.ordinal.saturating_add(1)),
            ck: CkWireMessage::synthetic_user_text("differential projection tail"),
        });
        let projection = crate::ck_wire::project_messages(&request.messages)
            .expect("DG projection must succeed");
        let incremental = crate::ck_wire::project_messages_incremental(
            &appended,
            &projection,
            request.messages.len(),
        )
        .expect("DG incremental projection must succeed");
        crate::transform::assert_prefix_projection_equivalent(&incremental, &appended)
            .expect("DG full projection must succeed");
    }
}

#[cfg(test)]
mod fixture_builder_tests {
    use super::super::test_support::FixtureBuilder;

    #[test]
    fn builders_cover_all_in_process_facade_shapes() {
        for fixture in [
            FixtureBuilder::session_with_boundary(),
            FixtureBuilder::tagged_session(),
            FixtureBuilder::frozen_reductions(),
            FixtureBuilder::synthetic_todo_armed(),
        ] {
            assert_eq!(fixture.handle_transform()["kind"], "transform");
            assert_eq!(fixture.call_transform()["session_id"], fixture.session_id);
            assert_eq!(fixture.state_import()["kind"], "state_import");
        }
    }
}
