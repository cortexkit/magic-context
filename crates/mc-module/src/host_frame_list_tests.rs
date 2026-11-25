use super::*;
use crate::summary::chunk::{self, Lines};
use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
use serde_json::{json, Value};

const TWO: &str = include_str!("../testdata/steer-frame-claude-code-v2/two-frames-read.json");
const ONE: &str = include_str!("../testdata/steer-frame-claude-code-v2/one-frame-read.json");
const BAD_TAIL: &str =
    include_str!("../testdata/steer-frame-claude-code-v2/bad-tail-candidates.json");
const REFUSED: &str = include_str!("../testdata/steer-frame-claude-code-v2/refused-read.json");
const COMPACTION_ENTRY: &str =
    include_str!("../testdata/steer-frame-claude-code-v2/compaction-entry.json");
const GATES: &str = include_str!("../testdata/steer-frame-claude-code-v2/compaction-gates.json");
const REAL_TWO: &str =
    include_str!("../testdata/host-frames-v1/two-frames-2.1.332/compaction-entry.json");
const REAL_ONE: &str =
    include_str!("../testdata/host-frames-v1/one-frame-2.1.331/compaction-entry.json");
const BLUE: &str = "Try the blue dial.";
const BRASS: &str = "Leave the brass latch open.";
const TOOL_OUTPUT: &str = "The dial is unlocked.";

fn read_page(entry: Value) -> Result<ReadPage, crate::client::ClientError> {
    let page = serde_json::to_vec(&json!({"entries": [entry], "head": Head::new()})).unwrap();
    crate::transport::decode_session_entries("host-frame-sample", &page)
}

fn decode(raw: Value) -> Entry {
    read_page(raw).unwrap().entries.remove(0)
}

fn sample(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap()
}

// The session.read samples name content by index; session.entries names
// stored part ids. Convert the reference without altering the payload.
fn compaction(raw: &str) -> Value {
    let read = sample(raw);
    let parts = read["message"]["content"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, body)| {
            let body = match body["type"].as_str().unwrap() {
                "tool_result" => PartBody::Tool(
                    ToolPart::new(
                        body["tool_use_id"].as_str().unwrap(),
                        "read",
                        json!({}),
                        ToolStatus::Completed,
                    )
                    .with_output(body["content"][0]["text"].as_str().unwrap()),
                ),
                "text" => PartBody::Text {
                    text: body["text"].as_str().unwrap().into(),
                },
                kind => panic!("unexpected sample kind {kind}"),
            };
            Part::new(format!("p{i}"), body).with_tag(i as u64 + 1)
        })
        .collect();
    let mut entry = serde_json::to_value(Entry::new(
        1,
        read["mid"].as_str().unwrap(),
        Role::User,
        read["written_at"].as_u64().unwrap(),
        parts,
    ))
    .unwrap();
    entry["host_frames"] = Value::Array(
        read["host_frames"]
            .as_array()
            .unwrap()
            .iter()
            .cloned()
            .map(|mut frame| {
                frame["part"] = json!(format!("p{}", frame["part"].as_u64().unwrap()));
                frame
            })
            .collect(),
    );
    entry
}

fn check_lines(entry: &Entry, expected: &[&str]) {
    let number = entry.ordinal;
    let merged = expected
        .iter()
        .map(|words| format!("[{number}] U: {words}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (mut session, _, _, _, _) = fixture();
    session.index = crate::index::Index::starting_at(number);
    session.index.extend([entry.clone()]);
    session.index_ready = true;
    assert_eq!(session.recent(10_000).unwrap()["text"], merged);
    let transcript = std::slice::from_ref(entry);
    let counter = crate::count::Counter::for_model(None);
    let printed = chunk::build(transcript, 10_000, counter).unwrap();
    assert_eq!(
        printed.input,
        format!("Messages {number}-{number}:\n\n{merged}")
    );
    let historian = chunk::build_with(transcript, 10_000, Lines::PerMessage, counter).unwrap();
    assert_eq!(
        historian.input,
        printed.input.replace(" U:", " U (mid-turn):")
    );
    assert_eq!(historian.validation.lines.len(), 1);
    assert!(historian.validation.lines[0].mid_turn);
    assert_eq!(historian.printed_blocks[0].parts, expected);
}

async fn expand_raw(entry: &Entry) -> String {
    let (session, client, _, _, _) = fixture();
    *client.entries.lock().unwrap() = vec![entry.clone()];
    crate::expand::run(
        &client,
        &session.key,
        session.limits,
        &json!({"message": entry.ordinal}),
        Some(entry.ordinal),
        crate::count::Counter::for_model(None),
        crate::expand::NumbersUnknown {
            refused: &mut Default::default(),
            summarized: false,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn two_frames() {
    let entry = decode(compaction(TWO));
    check_lines(&entry, &[BLUE, BRASS]);
    assert!(!trigger::is_meaningful_user(&entry));
    assert!(!lanes::starts_user_turn(&entry));
    assert!(crate::neutral::protects_from_automatic_reclaim(&entry));
    assert!(!crate::neutral::protects_from_explicit_drop(&entry));
    let raw = expand_raw(&entry).await;
    assert!(raw.contains(TOOL_OUTPUT), "{raw}");
    assert_eq!(raw.matches("[person's mid-turn words]").count(), 2);
    let mut conn = crate::context_db::ContextDb::fresh_in_memory();
    crate::search::messages::index(&mut conn, "mock", "session", &[entry]).unwrap();
    for query in ["blue", "brass"] {
        let rows = crate::search::messages::app_page(&conn, "session", query, 0, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].content, format!("{BLUE} {BRASS}"));
    }
    for query in ["unlocked", "alongside"] {
        assert!(crate::search::messages::app_page(&conn, "session", query, 0, 10).is_empty());
    }
}

#[test]
fn one_frame() {
    let mut raw = compaction(ONE);
    let entry = decode(raw.clone());
    check_lines(&entry, &[BRASS]);
    raw["host_frame"] = raw.as_object_mut().unwrap().remove("host_frames").unwrap()[0].clone();
    check_lines(&decode(raw), &[BRASS]);
}

#[tokio::test]
async fn bad_tail() {
    let entry = decode(compaction(BAD_TAIL));
    let sample = sample(BAD_TAIL);
    let stored = sample["message"]["content"][2]["text"].as_str().unwrap();
    let wrapped = stored.split_whitespace().collect::<Vec<_>>().join(" ");
    let (mut session, _, _, _, _) = fixture();
    session.index.extend([entry.clone()]);
    session.index_ready = true;
    assert_eq!(
        session.recent(10_000).unwrap()["text"],
        format!("[1] U: {BLUE}\n[1] U: {wrapped}")
    );
    let raw = expand_raw(&entry).await;
    assert!(raw.contains(stored), "{raw}");
    assert_eq!(raw.matches("[person's mid-turn words]").count(), 1);
}

#[test]
fn refused_read() {
    let (result, log) = crate::test_log::logged(|| read_page(compaction(REFUSED)));
    assert!(
        result.is_err(),
        "duplicate part facts must refuse the wire read"
    );
    let reason = "refused host-frame facts: entry \"fixture-duplicate-frame\": host_frames must be unique and in stored part order";
    assert!(
        log.contains(&format!(
            "session host-frame-sample: session.entries {reason}"
        )),
        "{log}"
    );

    use cortexkit_role_compaction::{ops, wire};
    let (session, _, _, _, _) = fixture();
    let mut params = serde_json::to_value(NoticeRequest::new(1, session.conditions)).unwrap();
    params["entries"] = json!([compaction(REFUSED)]);
    let body = wire::encode(ops::COMPACTION_NOTICE, &params);
    let (result, log) = crate::test_log::logged(|| {
        crate::transport::decode_entry_notice("host-frame-sample", &body, params)
    });
    assert!(result.is_err());
    assert!(
        log.contains(&format!(
            "session host-frame-sample: compaction.notice {reason}"
        )),
        "{log}"
    );

    // The typed wire refuses these shapes, but callers can construct an
    // Entry in memory. It should project exactly as if neither form was set.
    let mut plain = decode(compaction(TWO));
    let mut frames = plain.host_frames.take().unwrap();
    let mut both = plain.clone();
    both.host_frame = Some(frames[0].clone());
    both.host_frames = Some(frames.clone());
    let mut repeated = plain.clone();
    repeated.host_frames = Some(vec![frames[0].clone(); 2]);
    let mut reversed = plain.clone();
    frames.reverse();
    reversed.host_frames = Some(frames);
    let summary = |entry| chunk::build(&[entry], 10_000, crate::count::Counter::for_model(None));
    let plain = summary(plain);
    for malformed in [both, repeated, reversed] {
        assert!(!crate::neutral::has_verified_host_frames(&malformed));
        assert_eq!(summary(malformed), plain);
    }
}

#[test]
fn compaction_entry() {
    let raw = sample(COMPACTION_ENTRY);
    let entry = decode(raw.clone());
    check_lines(&entry, &[BLUE, BRASS]);
    assert_eq!(entry.parts[0].id, "z-first");
    assert_eq!(entry.parts[1].id, "a-second");
    assert_eq!(serde_json::to_value(entry).unwrap(), raw);
}

#[test]
fn compaction_gates() {
    let provides = serde_json::to_value(crate::transport::manifest("magic-context")).unwrap();
    let provides = provides["capabilities"]["provides"].as_array().unwrap();
    let gates = sample(GATES);
    for row in gates.as_array().unwrap() {
        assert_eq!(
            row["host_frames"],
            row["provides"]
                .as_array()
                .unwrap()
                .contains(&json!("compaction-host-frame/v2"))
        );
    }
    let provider = &gates[3]["provides"];
    for claim in provider.as_array().unwrap() {
        assert!(provides.contains(claim), "missing capability {claim}");
    }
}

#[test]
fn recorded_two_frames_2_1_332() {
    check_lines(
        &decode(sample(REAL_TWO)),
        &["MID_TURN_FIRST", "MID_TURN_SECOND"],
    );
}

#[test]
fn recorded_one_frame_2_1_331() {
    check_lines(&decode(sample(REAL_ONE)), &["please also check the logs"]);
}
