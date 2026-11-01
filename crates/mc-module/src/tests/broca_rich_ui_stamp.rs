//! Captured Broca rich-UI metadata must not change transcript interpretation.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) fn bytes(name: &str) -> Vec<u8> {
    std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/broca-rich-ui-stamp")
            .join(name),
    )
    .unwrap()
}

pub(crate) fn sample(name: &str) -> Value {
    serde_json::from_slice(&bytes(name)).unwrap()
}

pub(crate) fn answer(name: &str) -> Value {
    crate::session_resolver::read_runner_reply(sample(name))
        .unwrap_or_else(|error| panic!("{name}: {error}"))
}

#[test]
fn rich_ui_stamp_fixture_checksums() {
    let sums = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("testdata/broca-rich-ui-stamp/SHA256SUMS"),
    )
    .unwrap();
    let mut count = 0;
    for line in sums.lines() {
        let (expected, name) = line.split_once("  ").unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes(name))),
            expected,
            "{name}"
        );
        count += 1;
    }
    assert_eq!(count, 6);
}

#[test]
fn rich_ui_stamp_wrapped_replies() {
    for name in [
        "session.history.json",
        "session.head.json",
        "session.read.default.json",
        "session.read.opt-in.json",
        "role.describe.json",
    ] {
        assert!(answer(name).is_object(), "{name}");
    }
}

#[test]
fn rich_ui_stamp_head_meta() {
    let head: cortexkit_role_llm_runner::read::HeadMeta =
        crate::providers::decode(&answer("session.head.json")).unwrap();
    assert!(head.lineage_consistent());
    assert_eq!(head.first_ordinal, Some(0));
    assert_eq!(head.last_run_state.unwrap().state, "completed");
}

#[test]
fn rich_ui_stamp_history_forms() {
    let history = answer("session.history.json");
    let display: cortexkit_role_llm_runner::display::DisplayPage =
        crate::providers::decode(&history).unwrap();
    assert_eq!(display.messages.len(), 2);
    // ctx_expand requests raw history, not display rows. Keep that schema
    // boundary visible instead of silently converting the captured response.
    let error = serde_json::from_value::<cortexkit_role_llm_runner::history::HistoryPage>(history)
        .unwrap_err();
    assert_eq!(error.to_string(), "missing field `message`");
    eprintln!("display capture in raw history decoder: {error}");
}

#[test]
fn rich_ui_stamp_read_page_and_owned_broca_codec() {
    use crate::providers::codec::{Codec, InboundMessage};
    let mut decoded = Vec::new();
    for name in ["session.read.default.json", "session.read.opt-in.json"] {
        let page: cortexkit_role_llm_runner::read::ReadPage =
            crate::providers::decode(&answer(name)).unwrap();
        assert!(page.lineage_consistent());
        assert_eq!(page.messages.len(), 2);
        let mut messages = Vec::new();
        for entry in page.messages {
            let message = Codec::OwnedBroca
                .decode_message(&InboundMessage {
                    ordinal: entry.ordinal,
                    mid: entry.mid,
                    message: entry.message,
                })
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            messages.push(serde_json::to_value(message).unwrap());
        }
        decoded.push(messages);
    }
    assert_eq!(decoded[0], decoded[1], "the stamp is not message content");
}

#[test]
fn rich_ui_stamp_describe_and_follow_capabilities() {
    let describe = answer("role.describe.json");
    let parsed = cortexkit_role_llm_runner::describe::check_describe(&describe).unwrap();
    assert!(parsed.declares("rich_ui_stamp"));
    let follow = crate::runner_follow::FollowCapabilities::from_describe(&describe);
    assert_eq!(follow.missing(), None);
    assert!(follow.run_usage);
    let mut without = describe.clone();
    without["capabilities"]
        .as_array_mut()
        .unwrap()
        .retain(|group| group != "rich_ui_stamp");
    assert_eq!(
        crate::runner_limits::RunnerLimits::from_describe(&describe),
        crate::runner_limits::RunnerLimits::from_describe(&without)
    );
}

#[test]
fn rich_ui_stamp_run_started_control_wake() {
    let frame = sample("run_started.json");
    assert_eq!(frame["event"]["type"], "run_started");
    assert_eq!(frame["event"]["rich_ui"]["dialect"], "1.0");
    assert!(crate::runner_follow::control_wake(&frame));
}
