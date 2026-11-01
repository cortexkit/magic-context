//! Broca 0.7 wire samples through every ck-mc decode path that reads them.
//!
//! The fixtures under `testdata/broca-0.7/` are byte-identical copies of
//! captures taken over synthetic sessions (no production data). Each file has
//! a checksum test below. Each sample is then fed through the real decode
//! functions of every ck-mc path that reads that reply type, never a
//! hand-written copy of the decoder.
//!
//! Some reply types have no decode-path test because ck-mc has no call site
//! that sends them: display-form `session.history` rows (nothing sends
//! `form: "display"`), `run.event` and `run.skipped` (nothing sends either
//! method), and `run.tool_calls` (nothing sends it).

use cortexkit_role_llm_runner::capabilities as caps;
use cortexkit_role_llm_runner::describe::check_describe;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "broca_session_change.rs"]
mod session_change;

/// Exact bytes of each capture (no added newline). The table below is
/// checked byte for byte: a fixture that drifts from the capture fails here,
/// not somewhere downstream.
const FIXTURE_CHECKSUMS: &[(&str, &str)] = &[
    (
        "approved.run.tool_calls.json",
        "37f14cc85e54557fdc4e20874862f24cf16573ec01dab1d15dd129a764d82b0a",
    ),
    (
        "approved.session.history.json",
        "5dce0eff22e15a91432876e8e05fe2c1ae8751ac7f5450a2da2323f7ea5b4c7b",
    ),
    (
        "approved.session.read.json",
        "a36cb652ca21a93d2926b189e361cc61b57dc7cc35f08ce98f5bd4fd728d394b",
    ),
    (
        "approved.tool_finished.frame.json",
        "0c63291bf06027413dd532dcb6f4ca763e4c7e38faf67716e5875b8ad8387b2d",
    ),
    (
        "approved.tool_finished.json",
        "0e72ab584f955119aeb47647ba1d3133c97255e3102be918a9fdcb180b742cfe",
    ),
    (
        "approved.tool_started.frame.json",
        "b22790ea8a428992e189ad1dac400637d4513992b909a413869076240b7fd81d",
    ),
    (
        "approved.tool_started.json",
        "1fdbd242fdb028b8a44d5feb3db73429c3b3350000564e307c0410c454d94f66",
    ),
    (
        "role.describe.after.json",
        "2e7872593c0e4aa537284c3106409272ede672a3566547bbb86dd13bcf61e09e",
    ),
    (
        "role.describe.before.json",
        "5c182157802b48fbc00481b2bd37c7c6bb179296c5948fc219460ca993fbad3b",
    ),
    (
        "run.event.get.json",
        "b811e4c86c62b0f62bc5200ec0f471bf7b7136365077addd3fe8df31a89a3895",
    ),
    (
        "run.event.json",
        "11aed3e735464672ef27003a8b737f972d56dd6392ad2184d8e6c2280879a12a",
    ),
    (
        "run.skipped.get.json",
        "5abb85525df900b25db0209b2443d8d82a70a7d9d6a20c91dece98bf43cc494f",
    ),
    (
        "run.skipped.json",
        "a2b530b4706d53fbefa2c77590a40ba182d700592b9aba384991dd066d9c9836",
    ),
    (
        "session.head.completed.json",
        "1087ed11c22fce71f33ced1ec26a0219a67a779ff2d99bd3d7259dc427e7900a",
    ),
    (
        "session.head.error.fractional.json",
        "46f29ae0ad43e7ddffbd95d362938384d1b7b6e416d2254339221ba41017bf3d",
    ),
    (
        "session.head.error.missing-delay.json",
        "3ecebdb85bd31a9369e6fdf9d824803bd76302f1dfa37e3d60f72e21a36ff3e3",
    ),
    (
        "session.history.json",
        "9a0c7a1083ce1d7bcf51a0d0efc9e5b40eb709092116d22b9f326939aa8fe995",
    ),
    (
        "tool_finished.frame.json",
        "56fe2c46173e788654b6f1732d3db724affb529651eca7410681b04b5595128d",
    ),
    (
        "tool_finished.json",
        "3c5eceb62ea7659f9c45b0535214d845139f619b6313f2653649ff5c23f98225",
    ),
    (
        "tool_started.frame.json",
        "e5a6e62bfffb0a8f5c41e30192907b20e7762f8e44108a57a45ebd84df946164",
    ),
    (
        "tool_started.json",
        "1a297482f4d0bfaab2510ae4a461e934b2080c0af4a885970d8617cb4981e99d",
    ),
];

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("testdata")
        .join("broca-0.7")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("read {path:?}: {error}"))
}

fn fixture_json(name: &str) -> Value {
    serde_json::from_slice(&fixture_bytes(name))
        .unwrap_or_else(|error| panic!("parse {name}: {error}"))
}

fn fixture_answer(name: &str) -> Value {
    let reply = fixture_json(name);
    crate::session_resolver::read_runner_reply(reply)
        .unwrap_or_else(|error| panic!("envelope of {name}: {error}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn broca_0_7_fixtures_match_the_captured_checksums() {
    assert_eq!(FIXTURE_CHECKSUMS.len(), 21, "one row per capture");
    for (name, expected) in FIXTURE_CHECKSUMS {
        let digest = hex(&Sha256::digest(fixture_bytes(name)));
        assert_eq!(
            digest.as_str(),
            *expected,
            "fixture {name} drifted from its capture"
        );
    }
}

/// Setup's `role.describe` checks: the `tag_checkpoint` group gate, the
/// dreamer's admission and the summarizer's group reads. Both captures decode,
/// and the only decision inputs that change are the two new groups.
#[test]
fn broca_0_7_describe_decodes_and_keeps_setup_decisions() {
    let before = fixture_answer("role.describe.before.json");
    let after = fixture_answer("role.describe.after.json");
    let before_describe =
        check_describe(&before).unwrap_or_else(|problems| panic!("before: {problems:?}"));
    let after_describe =
        check_describe(&after).unwrap_or_else(|problems| panic!("after: {problems:?}"));
    let groups = |describe: &cortexkit_role_llm_runner::describe::RoleDescribe| {
        let mut groups = describe.capabilities.clone();
        groups.sort();
        groups
    };
    let mut before_groups = groups(&before_describe);
    let mut after_groups = groups(&after_describe);
    before_groups.retain(|group| group != "call_identity" && group != "system_text_default");
    after_groups.retain(|group| group != "call_identity" && group != "system_text_default");
    assert_eq!(
        before_groups, after_groups,
        "only the two new groups differ"
    );
    assert!(after_describe.declares("call_identity"));
    assert!(after_describe.declares("system_text_default"));
    assert!(!before_describe.declares("call_identity"));
    assert!(!before_describe.declares("system_text_default"));
    // The Setup checkpoint gate reads only this group: a checkpointed Setup is
    // refused under both captures, so the decision is unchanged.
    assert!(!before_describe.declares(caps::TAG_CHECKPOINT));
    assert!(!after_describe.declares(caps::TAG_CHECKPOINT));
    for describe in [&before_describe, &after_describe] {
        assert!(describe.declares("delivery_order"));
        assert!(describe.declares(caps::TRANSCRIPT_READS));
    }
    // The dreamer admits only when every negotiated group is present. Both
    // captures carry the full set, so admission is unchanged.
    let required = [
        caps::QUEUE,
        caps::RUN_OPS,
        caps::RUN_STATUS,
        caps::STREAMING,
        caps::RETENTION,
        caps::MAX_STEPS,
        caps::PLANS,
    ];
    assert!(before_describe.missing(&required).is_empty());
    assert!(after_describe.missing(&required).is_empty());
    for describe in [&before_describe, &after_describe] {
        let limits = describe
            .retention
            .filter(|limits| limits.max_seconds > 0 && limits.delete_within_ms > 0);
        assert!(limits.is_some(), "retention stays usable: {limits:?}");
        assert!(
            describe
                .run_cancel
                .as_ref()
                .is_some_and(|cancel| cancel.at.iter().any(|at| at == "step_boundary")),
            "step-boundary cancel stays advertised"
        );
    }
}

/// The summarizer's group reads and the follow predicate: both captures say
/// the same thing, so historian and follow decisions are unchanged.
#[test]
fn broca_0_7_summarizer_and_follow_decisions_are_unchanged() {
    let before = fixture_answer("role.describe.before.json");
    let after = fixture_answer("role.describe.after.json");
    assert_eq!(
        crate::runner_limits::RunnerLimits::from_describe(&before),
        crate::runner_limits::RunnerLimits::from_describe(&after)
    );
    let before_follow = crate::runner_follow::FollowCapabilities::from_describe(&before);
    let after_follow = crate::runner_follow::FollowCapabilities::from_describe(&after);
    assert_eq!(before_follow.missing(), None);
    assert_eq!(after_follow.missing(), None);
    assert!(before_follow.run_usage && after_follow.run_usage);
}

/// The one strict decoder every unary path shares
/// (`session_resolver::read_runner_reply`): every wrapped capture keeps the
/// expected reply envelope of exactly one `result` member, and stream units
/// are not unary replies, so they are refused by name instead of being
/// misread.
#[test]
fn broca_0_7_strict_envelope_accepts_replies_and_refuses_stream_units() {
    for name in [
        "role.describe.after.json",
        "role.describe.before.json",
        "approved.session.read.json",
        "approved.session.history.json",
        "session.history.json",
        "session.head.completed.json",
        "session.head.error.fractional.json",
        "session.head.error.missing-delay.json",
        "run.event.get.json",
        "run.skipped.get.json",
    ] {
        let reply = fixture_json(name);
        assert!(reply.get("result").is_some(), "{name} keeps its envelope");
        crate::session_resolver::read_runner_reply(reply)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    // Stream units ride the subscription, never a unary reply: the strict
    // envelope refuses them instead of peeling a field out of them.
    for name in [
        "tool_started.frame.json",
        "tool_finished.frame.json",
        "approved.tool_started.frame.json",
        "approved.tool_finished.frame.json",
    ] {
        let unit = fixture_json(name);
        assert_eq!(unit["kind"], serde_json::json!("control"));
        match crate::session_resolver::read_runner_reply(unit.clone()) {
            Err(crate::session_resolver::SessionResolveError::ReplyShape(_)) => {}
            other => panic!("{name} is a stream unit, not a reply: {other:?}"),
        }
    }
    // A bare answer without its reply wrapper is refused the same way, never
    // decoded as if it were already unwrapped.
    let page = fixture_answer("approved.session.read.json");
    match crate::session_resolver::read_runner_reply(page.clone()) {
        Err(crate::session_resolver::SessionResolveError::ReplyShape(_)) => {}
        other => panic!("bare page was not refused: {other:?}"),
    }
}

/// `session.read` decoding: the approved capture keeps the recorded call key
/// ending in `:5` (the key recorded when the call was prepared, not the later
/// dispatch intent's sequence) in tool-call attribution, and every entry still
/// passes the strict owned-broca message decode that notice ingest runs per
/// entry.
#[test]
fn broca_0_7_approved_read_keeps_the_recorded_call_key() {
    let answer = fixture_answer("approved.session.read.json");
    // The live read never decodes a whole `ReadPage`: it reads the page's
    // members from the answer and decodes only the messages. The whole-page
    // decode and the message-list decode below both tolerate the new
    // top-level members (`lineage_state`, `deferred_calls`, ...).
    let page: cortexkit_role_llm_runner::read::ReadPage =
        crate::providers::decode(&answer).unwrap_or_else(|error| panic!("{error:?}"));
    assert!(page.lineage_consistent());
    let messages: Vec<cortexkit_role_llm_runner::read::ReadMessage> =
        crate::providers::decode(&answer["messages"]).unwrap_or_else(|error| panic!("{error:?}"));
    assert_eq!(messages.len(), 4);
    assert_eq!(page.messages.len(), 4);
    let attributed = messages
        .iter()
        .find(|entry| entry.ordinal == 1)
        .expect("assistant tool-call message");
    assert_eq!(attributed.tool_calls.len(), 1);
    assert_eq!(attributed.tool_calls[0].tool_call_id, "approved-call");
    assert_eq!(
        attributed.tool_calls[0].call_key.as_deref(),
        Some("8fc1fdb7-1e03-4f62-a690-6bcfe91075b6:5"),
        "attribution keeps the recorded key, not the intent sequence"
    );
    assert_eq!(
        attributed.tool_calls[0].dispatched_to.as_deref(),
        Some("synthetic-tools")
    );
    // The tool result pairs with the call by the model's id, which is the id
    // ck-mc's tool-arc pairing check reads; the recorded key is stored
    // alongside that id.
    for entry in &messages {
        let decoded = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&crate::providers::codec::InboundMessage {
                ordinal: entry.ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            })
            .unwrap_or_else(|error| panic!("ordinal {}: {error:?}", entry.ordinal));
        assert_eq!(decoded.mid, entry.mid);
    }
    let result = messages
        .iter()
        .find(|entry| entry.ordinal == 2)
        .expect("tool result message");
    let kinds: Vec<&str> = result
        .message
        .pointer("/content")
        .and_then(Value::as_array)
        .expect("native content")
        .iter()
        .filter_map(|part| part.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(kinds, vec!["tool_result"]);
}

/// `session.head` decoding: the completed head and both failed-last-run
/// heads decode through the lenient `HeadMeta` type used when a ceiling ride
/// or the lineage window reads the head, with lineage fields intact. The two error heads
/// carry the `last_run_error` member, which llm-runner 0.7.5 added to
/// `HeadMeta`: the typed decode now keeps it, and re-encodes it exactly as
/// the runner sent it. ck-mc reads no decision from it, so nothing ck-mc
/// does changes; what this pins is that the member never makes a head
/// refused or lossy.
#[test]
fn broca_0_7_heads_decode_with_lineage_intact() {
    for name in [
        "session.head.completed.json",
        "session.head.error.fractional.json",
        "session.head.error.missing-delay.json",
    ] {
        let answer = fixture_answer(name);
        let head: cortexkit_role_llm_runner::read::HeadMeta =
            crate::providers::decode(&answer).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(head.lineage_consistent(), "{name}");
        assert!(head.lineage_id.is_some(), "{name}");
        assert_eq!(head.first_ordinal, Some(0), "{name}");
        assert_eq!(
            head.last_run_error().is_some(),
            answer.get("last_run_error").is_some(),
            "{name}: the typed head keeps last_run_error exactly when it is sent"
        );
        let roundtrip = serde_json::to_value(&head).expect("HeadMeta serializes");
        assert_eq!(
            roundtrip.get("last_run_error"),
            answer.get("last_run_error"),
            "{name}: last_run_error re-encodes as the runner sent it"
        );
    }
    let completed = fixture_answer("session.head.completed.json");
    let completed_head: cortexkit_role_llm_runner::read::HeadMeta =
        crate::providers::decode(&completed).unwrap_or_else(|error| panic!("{error:?}"));
    assert_eq!(
        completed_head
            .last_run_state
            .as_ref()
            .map(|state| state.state.as_str()),
        Some("completed")
    );
    // The fractional head shows an exact 1.5-second delay; the other error
    // head shows an absent delay with the same recorded reset time. Both sit
    // beside the decoded `last_run_state`, which still says `error`.
    for (name, delay) in [
        ("session.head.error.fractional.json", Some(1.5)),
        ("session.head.error.missing-delay.json", None),
    ] {
        let answer = fixture_answer(name);
        let head: cortexkit_role_llm_runner::read::HeadMeta =
            crate::providers::decode(&answer).unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            head.last_run_state
                .as_ref()
                .map(|state| state.state.as_str()),
            Some("error"),
            "{name}"
        );
        assert_eq!(
            answer["last_run_error"]["class"],
            serde_json::json!("transient"),
            "{name}"
        );
        match delay {
            Some(delay) => assert_eq!(
                answer["last_run_error"]["retry_after_secs"],
                serde_json::json!(delay),
                "{name}"
            ),
            None => assert!(
                answer["last_run_error"].get("retry_after_secs").is_none(),
                "{name}: absent delay stays absent, not zero"
            ),
        }
        assert_eq!(
            answer["last_run_error"]["resets_at_ms"],
            serde_json::json!(1790000003000u64),
            "{name}"
        );
    }
}

/// Live display rows and tool events: ck-mc reads subscription units as
/// control-wake hints, never as typed events, so the new `call_key` and
/// `schema_pin` members ride beside the fields ck-mc checks. A prepared
/// call's start carries the key with no pin yet; the pin is absent, not
/// empty.
#[test]
fn broca_0_7_live_units_wake_with_key_and_pin() {
    for (name, call_id, pin) in [
        ("tool_started.frame.json", "sample-call", true),
        ("tool_finished.frame.json", "sample-call", true),
        ("approved.tool_started.frame.json", "approved-call", false),
        ("approved.tool_finished.frame.json", "approved-call", true),
    ] {
        let unit = fixture_json(name);
        assert!(
            crate::runner_follow::control_wake(&unit),
            "{name}: control units stay wake hints"
        );
        let event = &unit["event"];
        assert_eq!(event["tool_call_id"], serde_json::json!(call_id), "{name}");
        let key = event["call_key"]
            .as_str()
            .unwrap_or_else(|| panic!("{name}: no call_key"));
        assert!(
            key.ends_with(":5"),
            "{name}: recorded key, not intent sequence"
        );
        if pin {
            assert!(
                event["schema_pin"]
                    .as_str()
                    .is_some_and(|pin| !pin.is_empty()),
                "{name}: dispatched calls carry a pin"
            );
        } else {
            assert!(
                event.get("schema_pin").is_none(),
                "{name}: a prepared call has the key but no pin yet"
            );
        }
    }
    // The bare event bytes are the frame's nested event, not a re-serialised
    // projection: the frame and its bare twin name the same call and key.
    for (frame, bare) in [
        ("tool_started.frame.json", "tool_started.json"),
        ("tool_finished.frame.json", "tool_finished.json"),
        (
            "approved.tool_started.frame.json",
            "approved.tool_started.json",
        ),
        (
            "approved.tool_finished.frame.json",
            "approved.tool_finished.json",
        ),
    ] {
        let unit = fixture_json(frame);
        let event: Value = serde_json::from_slice(&fixture_bytes(bare))
            .unwrap_or_else(|error| panic!("{bare}: {error}"));
        assert_eq!(&unit["event"], &event, "{frame} nests {bare} verbatim");
    }
}

/// The offline first-pass describe pin: it hashes the full raw describe, so
/// the two new groups change the pin even though the descriptor still
/// decodes. A rerun against the same bytes keeps its pin.
#[test]
fn broca_0_7_offline_describe_pin_sees_the_wire_change() {
    let before = fixture_answer("role.describe.before.json");
    let after = fixture_answer("role.describe.after.json");
    let pin = crate::providers::offline_first_pass_engine::runner_describe_digest;
    let before_pin = pin(&before).expect("before pins");
    let after_pin = pin(&after).expect("after pins");
    assert_ne!(
        before_pin, after_pin,
        "the pin covers the two new groups, so a prepared pass is rechecked, not misadopted"
    );
    assert_eq!(pin(&before).expect("before pins again"), before_pin);
    assert_eq!(pin(&after).expect("after pins again"), after_pin);
}
