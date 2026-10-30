//! Captured Broca session-change replies through ck-mc's runner readers.

use cortexkit_role_llm_runner::{
    baseline::BaselineReply, describe::check_describe, send::SendReply,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const CAPTURES: &[(&str, &[u8])] = &[
    (
        "role.describe.session_change.json",
        include_bytes!(
            "../../testdata/broca-session-change-0.3.285/role.describe.session_change.json"
        ),
    ),
    (
        "session.baseline.applied.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.baseline.applied.json"),
    ),
    (
        "session.baseline.initial.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.baseline.initial.json"),
    ),
    (
        "session.baseline.pending.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.baseline.pending.json"),
    ),
    (
        "session.flush_prefix.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.flush_prefix.json"),
    ),
    (
        "session.refresh.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.refresh.json"),
    ),
    (
        "session.refresh.plan_model_mismatch.json",
        include_bytes!(
            "../../testdata/broca-session-change-0.3.285/session.refresh.plan_model_mismatch.json"
        ),
    ),
    (
        "session.refresh_policy.json",
        include_bytes!("../../testdata/broca-session-change-0.3.285/session.refresh_policy.json"),
    ),
];

fn answer(name: &str) -> Value {
    let bytes = CAPTURES.iter().find(|(file, _)| *file == name).unwrap().1;
    crate::session_resolver::read_runner_reply(serde_json::from_slice(bytes).unwrap())
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[test]
fn broca_session_change_captures_match_supplied_checksums() {
    let manifest = include_str!("../../testdata/broca-session-change-0.3.285/SHA256SUMS");
    assert_eq!(manifest.lines().count(), 8);
    assert_eq!(CAPTURES.len(), 8);
    for line in manifest.lines() {
        let (expected, name) = line.split_once("  ").unwrap();
        let bytes = CAPTURES.iter().find(|(file, _)| *file == name).unwrap().1;
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), expected, "{name}");
    }
}

#[test]
fn broca_session_change_baselines_decode_in_send_replies_with_rungs() {
    for (name, accepted, applied) in [
        ("session.baseline.initial.json", 0, 0),
        ("session.baseline.pending.json", 1, 0),
        ("session.baseline.applied.json", 1, 1),
    ] {
        let value = answer(name);
        let baseline: BaselineReply = serde_json::from_value(value.clone()).unwrap();
        // Broca supplied baseline captures, not session.send captures. Place the
        // captured baseline unchanged in the admission reply that carries it too.
        let sent = crate::session_resolver::read_runner_reply(json!({"result": {
            "state":"active", "run_id":"fixture-run", "baseline":value["baseline"]
        }}))
        .unwrap();
        let sent: SendReply = serde_json::from_value(sent).unwrap();
        assert_eq!(sent.baseline, baseline.baseline, "{name}");
        let baseline = sent.baseline.unwrap();
        assert_eq!(baseline.accepted_generation, accepted, "{name}");
        assert_eq!(baseline.applied_generation, applied, "{name}");
        let rungs = baseline.rungs.unwrap();
        assert_eq!(rungs.tools, ["on_prefix_rebuild", "immediately"], "{name}");
        assert_eq!(
            rungs.system_text,
            ["on_prefix_rebuild", "immediately"],
            "{name}"
        );
        assert_eq!(baseline.pending.is_some(), accepted > applied, "{name}");
        assert_eq!(baseline.effective.is_some(), applied > 0, "{name}");
    }
}

#[test]
fn broca_session_change_describe_keeps_reader_decisions() {
    let value = answer("role.describe.session_change.json");
    let description = check_describe(&value).unwrap();
    assert_eq!(description.implementation_version, "0.3.285");
    assert!(description.declares("session_change"));
    assert!(description
        .missing(&[
            "queue",
            "run_ops",
            "run_status",
            "streaming",
            "retention",
            "max_steps",
            "plans"
        ])
        .is_empty());
    assert!(description
        .run_cancel
        .unwrap()
        .at
        .iter()
        .any(|at| at == "step_boundary"));
    assert_eq!(description.retention.unwrap().max_seconds, 2_592_000);
    let follow = crate::runner_follow::FollowCapabilities::from_describe(&value);
    assert_eq!(follow.missing(), None);
    assert!(follow.run_usage);
    assert!(crate::runner_limits::RunnerLimits::from_describe(&value).max_steps);
}

#[test]
fn broca_session_change_operation_samples_decode() {
    use cortexkit_role_llm_runner::session_change::{
        FlushPrefixReply, RefreshPolicyReply, RefreshReply,
    };
    let refresh: RefreshReply = serde_json::from_value(answer("session.refresh.json")).unwrap();
    assert_eq!(refresh.accepted_generation, 1);
    assert!(!refresh.run_in_progress);
    assert!(refresh.applies_from_next_run);
    let policy: RefreshPolicyReply =
        serde_json::from_value(answer("session.refresh_policy.json")).unwrap();
    assert_eq!(policy.pending.generation, 1);
    let flush: FlushPrefixReply =
        serde_json::from_value(answer("session.flush_prefix.json")).unwrap();
    assert_eq!(flush.pending_generation, Some(3));
    let bytes = CAPTURES
        .iter()
        .find(|(name, _)| *name == "session.refresh.plan_model_mismatch.json")
        .unwrap()
        .1;
    let refusal: Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(refusal["code"], "plan_model_mismatch");
    // This capture is a transport error body, not a successful reply.
    // The success reader must refuse it rather than inventing a result envelope.
    let error = crate::session_resolver::read_runner_reply(refusal).unwrap_err();
    assert!(error.to_string().contains("runner_reply_shape"), "{error}");
}
