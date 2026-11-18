use super::*;
use cortexkit_role_llm_runner::delivery_order::render;

const MINUTE: u64 = 60_000;

#[test]
fn the_note_renders_as_the_runner_renders_a_utc_minute() {
    // The llm-runner contract's datetime-slot sample (cortexkit-role-llm-runner
    // 0.8.62): 1795042320 seconds is Wed 18 Nov 22:52Z.
    let rendered = render(&[template()], &note(1_795_042_320_999), |_| None).unwrap();
    assert_eq!(rendered, "Now: Wed 18 Nov 22:52Z");
    // Day, hour and minute are zero-padded; seconds are dropped.
    let rendered = render(&[template()], &note(90_061_000), |_| None).unwrap();
    assert_eq!(rendered, "Now: Fri 02 Jan 01:01Z");
    // A send names the template by id and digest, with the time in whole
    // seconds.
    let used = note(1_795_042_320_999);
    assert_eq!(used.id, TEMPLATE);
    assert_eq!(used.digest, template_digest(&template()));
    assert_eq!(used.slots["now"], json!(1_795_042_320_u64));
}

#[test]
fn the_template_is_the_contract_clock_notice_under_ck_mc_s_id() {
    let value = serde_json::to_value(template()).unwrap();
    assert_eq!(
        value,
        json!({
            "id": TEMPLATE,
            "text": "Now: {now}",
            "slots": {"now": {"type": "datetime", "format": "utc_minute"}},
        })
    );
}

#[test]
fn delivery_lists_turn_system_only_for_a_runner_that_declares_it() {
    assert_eq!(delivery(true), vec![Mode::TurnSystem, Mode::ToolResult]);
    assert_eq!(delivery(false), vec![Mode::ToolResult]);
}

#[test]
fn intervals_are_minutes_or_hours_or_off() {
    for (text, minutes) in [
        ("10m", 10),
        ("30m", 30),
        ("42m", 42),
        ("1h", 60),
        ("2h", 120),
        (" 15m ", 15),
    ] {
        assert_eq!(
            parse_interval(&json!(text)),
            Ok(Some(minutes * MINUTE)),
            "{text}"
        );
    }
    assert_eq!(parse_interval(&json!(false)), Ok(None));
}

#[test]
fn every_other_interval_is_refused_with_a_message_naming_the_key() {
    for value in [
        json!(true),
        json!(30),
        json!("30"),
        json!("30s"),
        json!("1d"),
        json!("0m"),
        json!("-5m"),
        json!("1.5h"),
        json!("m"),
        json!("30 m"),
        json!("30M"),
        json!(""),
        json!(null),
        json!({"minutes": 30}),
        json!("99999999999999999999m"),
    ] {
        let error = parse_interval(&value).expect_err(&value.to_string());
        assert!(
            error.starts_with("clock_note must be false or a duration"),
            "{error}"
        );
        assert!(error.contains(&value.to_string()), "{error}");
    }
}

#[test]
fn a_session_without_a_note_is_due_at_once() {
    assert!(State::default().due(1_000, DEFAULT_INTERVAL_MS));
}

#[test]
fn a_note_is_due_again_only_after_the_interval() {
    let state = State {
        last_sent_ms: Some(10 * MINUTE),
        refused: false,
    };
    assert!(!state.due(10 * MINUTE, 30 * MINUTE));
    assert!(!state.due(39 * MINUTE + 59_999, 30 * MINUTE));
    assert!(state.due(40 * MINUTE, 30 * MINUTE));
    assert!(state.due(90 * MINUTE, 30 * MINUTE));
    // A clock set back before the last note makes one due, so a wrong time
    // is corrected at once rather than kept until the clock catches up.
    assert!(state.due(5 * MINUTE, 30 * MINUTE));
}

#[test]
fn a_refused_plan_stops_notes_whatever_the_time() {
    let state = State {
        last_sent_ms: None,
        refused: true,
    };
    assert!(!state.due(u64::MAX / 2, MINUTE));
}

#[test]
fn the_state_survives_saving_and_leaves_no_trace_while_empty() {
    assert_eq!(serde_json::to_value(State::default()).unwrap(), json!({}));
    let state = State {
        last_sent_ms: Some(42),
        refused: true,
    };
    let saved = serde_json::to_string(&state).unwrap();
    assert_eq!(saved, r#"{"last_sent_ms":42,"refused":true}"#);
    assert_eq!(serde_json::from_str::<State>(&saved).unwrap(), state);
}

#[test]
fn only_a_refusal_naming_the_template_means_the_plan_lacks_it() {
    let refusal = |code: &str, detail: Option<Value>| crate::client::ClientError {
        detail,
        ..crate::client::ClientError::refused(code, "refused")
    };
    assert!(plan_lacks_template(&refusal(
        "invalid_params",
        Some(json!({"field": "template"}))
    )));
    assert!(!plan_lacks_template(&refusal(
        "invalid_params",
        Some(json!({"field": "delivery"}))
    )));
    assert!(!plan_lacks_template(&refusal("invalid_params", None)));
    assert!(!plan_lacks_template(&refusal(
        "delivery_unsupported",
        Some(json!({"field": "template"}))
    )));
    assert!(!plan_lacks_template(&crate::client::ClientError::new(
        "connection lost"
    )));
}

/// The sample set `mc-clock-note-samples-v1`: the `session.send` that
/// carries a clock note, for a runner that takes `turn_system` and for one
/// that doesn't, and ck-mc's `role.describe` reply with the clock template in
/// its `reminder_templates`. Regenerate deliberately from the workspace
/// root: `MC_REGENERATE_CLOCK_NOTE_SAMPLES=1 cargo test --locked -p
/// mc-module --lib clock_note::tests::samples_v1 -- --exact`. Set the
/// variable to an output directory instead of `1` for a read-only checkout.
#[test]
fn samples_v1() {
    use cortexkit_role_llm_runner::delivery_order::DeliveryOrder;
    use cortexkit_role_llm_runner::send::SendRequest;
    use sha2::Digest;

    let pretty = |value: &Value| format!("{}\n", serde_json::to_string_pretty(value).unwrap());
    // 2026-11-18T22:52:00Z, the time in the llm-runner contract's datetime-slot
    // sample (cortexkit-role-llm-runner 0.8.62).
    let now_ms = 1_795_042_320_000;
    let send = |name: &str, turn_system: bool| {
        let request = SendRequest::template(
            "mc.clock_note:counter:7",
            &DeliveryOrder::new(delivery(turn_system))
                .with_dedupe_key(KIND)
                .with_template(note(now_ms)),
        );
        let body = cortexkit_role_compaction::wire::encode(
            cortexkit_role_llm_runner::ops::SESSION_SEND,
            &request,
        );
        let wire: Value = serde_json::from_slice(&body).unwrap();
        let rendered = render(
            &crate::nudges::templates(),
            request
                .delivery_order()
                .unwrap()
                .unwrap()
                .template
                .as_ref()
                .unwrap(),
            |_| None,
        )
        .unwrap();
        assert_eq!(rendered, "Now: Wed 18 Nov 22:52Z");
        pretty(&json!({"name": name, "request": wire, "rendered": rendered}))
    };
    let mut describe: Value =
        serde_json::from_slice(&crate::catalog::role_describe_bytes().unwrap()).unwrap();
    // The build's own version line changes with every build.
    describe["implementation_version"] = json!("ck-mc (normalized)");
    let listed = describe["reminder_templates"]["templates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == TEMPLATE)
        .cloned()
        .expect("the catalog lists the clock template");
    assert_eq!(
        listed,
        json!({
            "id": TEMPLATE,
            "digest": template_digest(&template()),
            "delivery": ["turn_system", "tool_result"],
        })
    );
    assert!(describe["reminder_templates"]["sender"]["templates"]
        .as_array()
        .unwrap()
        .contains(&serde_json::to_value(template()).unwrap()));
    let samples = std::collections::BTreeMap::from([
        (
            "session-send-turn-system.json",
            send("session-send-turn-system", true),
        ),
        (
            "session-send-tool-result.json",
            send("session-send-tool-result", false),
        ),
        ("role-describe.json", pretty(&describe)),
    ]);

    let mut root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/mc-clock-note-samples-v1");
    let output = std::env::var_os("MC_REGENERATE_CLOCK_NOTE_SAMPLES");
    let regenerate = output.is_some();
    if let Some(output) = output.filter(|value| value != "1") {
        root = output.into();
    }
    if regenerate {
        std::fs::create_dir_all(&root).unwrap();
    }
    let mut sums = String::new();
    for (name, text) in &samples {
        sums.push_str(&format!("{:x}  {name}\n", sha2::Sha256::digest(text)));
        if regenerate {
            std::fs::write(root.join(name), text).unwrap();
        }
        assert_eq!(
            &std::fs::read_to_string(root.join(name))
                .unwrap_or_else(|_| panic!("missing sample {name}")),
            text,
            "stale {name}"
        );
    }
    if regenerate {
        std::fs::write(root.join("SHA256SUMS"), &sums).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(root.join("SHA256SUMS")).unwrap(),
        sums,
        "stale sample checksums"
    );
    for entry in std::fs::read_dir(&root).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            name == "README.md" || name == "SHA256SUMS" || samples.contains_key(name.as_str()),
            "unexpected file {name}"
        );
    }
}
