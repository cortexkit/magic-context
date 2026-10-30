use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("testdata/broca-session-change")
}

pub(crate) fn sample(name: &str) -> Value {
    let bytes = sample_bytes(name);
    serde_json::from_slice(&bytes).unwrap()
}

pub(crate) fn sample_bytes(name: &str) -> Vec<u8> {
    std::fs::read(corpus().join(name)).unwrap()
}

#[test]
fn broca_session_change_captured_bytes_match_both_supplied_manifests() {
    for name in ["SHA256SUMS", "send-reply-goldens/SHA256SUMS"] {
        let manifest = corpus().join(name);
        let rows = std::fs::read_to_string(&manifest).unwrap();
        assert_eq!(rows.lines().count(), 8, "{name}");
        for row in rows.lines() {
            let (expected, file) = row.split_once("  ").unwrap();
            let bytes = std::fs::read(manifest.parent().unwrap().join(file)).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected, "{file}");
        }
    }
}

#[test]
fn broca_session_change_success_envelopes_use_the_pinned_result_wrapper() {
    for name in [
        "role.describe.session_change.json",
        "session.baseline.initial.json",
        "session.baseline.pending.json",
        "session.baseline.applied.json",
        "session.refresh.json",
        "session.refresh_policy.json",
        "session.flush_prefix.json",
    ] {
        let wire = sample(name);
        let expected = wire["result"].clone();
        assert!(!expected.is_null(), "{name}");
        let decoded = crate::session_resolver::read_runner_reply(wire.clone())
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(decoded, expected, "{name}");

        let mut extra = wire;
        extra["unexpected"] = Value::Bool(true);
        let error = crate::session_resolver::read_runner_reply(extra).unwrap_err();
        assert!(error.to_string().contains("unexpected"), "{name}: {error}");
    }
}

#[test]
fn broca_session_change_before_and_after_goldens_decode_inside_result() {
    // Broca's reply goldens contain the answer body, not the serve envelope.
    for stem in [
        "send_reply.admission",
        "send_reply.session_class",
        "session_baseline.cache",
        "session_baseline.ready",
    ] {
        for suffix in ["before", "after"] {
            let name = format!("send-reply-goldens/{stem}.json.{suffix}");
            let answer = sample(&name);
            let decoded = crate::session_resolver::read_runner_reply(
                serde_json::json!({"result": answer.clone()}),
            )
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_eq!(decoded, answer, "{name}");
            assert!(decoded["baseline"]["items"].is_array(), "{name}");
            assert_eq!(decoded["baseline"]["rungs"].is_object(), suffix == "after");
        }
    }
}

#[test]
fn broca_session_change_describe_checks_groups_ops_and_offline_pin() {
    let answer =
        crate::session_resolver::read_runner_reply(sample("role.describe.session_change.json"))
            .unwrap();
    let describe = cortexkit_role_llm_runner::describe::check_describe(&answer)
        .unwrap_or_else(|problems| panic!("{problems:?}"));
    assert!(describe.declares("session_change"));
    assert!(describe.declares("delivery_order"));
    assert!(describe.declares("transcript_reads"));
    for op in [
        "session.refresh",
        "session.refresh_policy",
        "session.flush_prefix",
    ] {
        assert!(answer["majors"][0]["ops"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(op)));
    }
    crate::providers::offline_first_pass_engine::runner_describe_digest(&answer)
        .expect("offline first-pass descriptor validation and pin");
}

#[test]
fn broca_session_change_describe_keeps_follow_and_run_limit_capabilities() {
    let answer =
        crate::session_resolver::read_runner_reply(sample("role.describe.session_change.json"))
            .unwrap();
    let follow = crate::runner_follow::FollowCapabilities::from_describe(&answer);
    assert!(follow.run_ops && follow.run_status && follow.streaming && follow.run_usage);
    assert_eq!(follow.missing(), None);
    let limits = crate::runner_limits::RunnerLimits::from_describe(&answer);
    assert!(limits.max_steps);
    assert!(limits.no_tools);
    assert!(!limits.max_output_tokens);
}

#[test]
fn broca_session_change_send_reply_does_not_match_members_exactly() {
    use cortexkit_role_llm_runner::send::{SendReply, SendState};
    let mut reply = sample("send-reply-goldens/send_reply.admission.json.after");
    reply["future_reply_member"] = serde_json::json!({"enabled": true});
    reply["baseline"]["future_baseline_member"] = serde_json::json!({"enabled": true});
    let decoded: SendReply = serde_json::from_value(reply).unwrap();
    assert_eq!(decoded.send_state(), SendState::Active);
    assert_eq!(decoded.run_id.as_deref(), Some("run-1"));
}
