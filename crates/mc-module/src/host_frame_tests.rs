use super::*;
use crate::summary::{chunk, validate};
use cortexkit_role_compaction::read::{HostFrame, NoticeOrigin};
use cortexkit_role_llm_runner::attribution::host_frames::{
    CLAUDE_CODE_MID_TURN, CLAUDE_CODE_MID_TURN_HEAD, CLAUDE_CODE_MID_TURN_TAIL,
};
use serde_json::json;

const WORDS: &str = "Please keep the sapphire branch";

fn stored() -> String {
    format!("{CLAUDE_CODE_MID_TURN_HEAD}{WORDS}{CLAUDE_CODE_MID_TURN_TAIL}")
}

fn raw(ordinal: u64, role: Role, contents: &str) -> Entry {
    Entry::new(
        ordinal,
        "steer",
        role,
        ordinal,
        vec![Part::new(
            "words",
            PartBody::Text {
                text: contents.into(),
            },
        )
        .with_tag(ordinal)],
    )
}

fn marked(entry: Entry, code: &str) -> Entry {
    entry
        .with_host_frame(
            HostFrame::new(
                "words",
                code,
                CLAUDE_CODE_MID_TURN_HEAD.len() as u32,
                CLAUDE_CODE_MID_TURN_TAIL.len() as u32,
            ),
            true,
        )
        .unwrap()
}

fn frame(ordinal: u64, role: Role) -> Entry {
    marked(raw(ordinal, role, &stored()), CLAUDE_CODE_MID_TURN)
}

fn counter() -> crate::count::Counter {
    crate::count::Counter::for_model(None)
}

#[test]
fn host_frame_summary_and_phone_recent_show_only_the_persons_words() {
    let (mut session, _, _, _, _) = fixture();
    let entries = [frame(1, Role::System)];
    let rendered = chunk::build(&entries, 10_000, counter()).expect("mid-turn words have a line");
    assert_eq!(rendered.printed_blocks[0].role, "U");
    assert_eq!(rendered.printed_blocks[0].parts, [WORDS]);
    session.index.extend(entries);
    session.index_ready = true;
    let recent = session.recent(10_000).unwrap();
    assert_eq!(recent["text"], rendered.input.split_once("\n\n").unwrap().1);
    assert_eq!(recent["from_message"], 1);
    assert_eq!(recent["through_message"], 1);
}

#[test]
fn host_frame_unverified_metadata_keeps_legacy_summary_request_and_view_bytes() {
    use sha2::{Digest, Sha256};
    for (contents, code, pin) in [
        (
            stored().replacen('T', "?", 1),
            CLAUDE_CODE_MID_TURN,
            "0d1ea33b42da37981321813cb3e3b87aae24cc80d5f256a83b635281347f2e9a",
        ),
        (
            stored(),
            "future_frame",
            "f132a152b8753befc3fa8593a75aacdb778d69154bbbdcfe951d45af3f54e73b",
        ),
    ] {
        let evaluate = |entry: Entry| {
            let (mut session, _, _, _, settings) = fixture();
            let entries = [text(1, "Ordinary request"), entry];
            let request = chunk::build(&entries, 10_000, counter()).unwrap();
            session.index.extend(entries);
            let mut keep = output_part("keep", 3);
            if let PartBody::Tool(tool) = &mut keep.body {
                tool.name = "ctx_keep".into();
            }
            session
                .index
                .extend([Entry::new(3, "kept", Role::Assistant, 3, vec![keep])]);
            let view = session
                .build(&settings, None, false, Some(&Default::default()))
                .0
                .unwrap();
            (
                request.input,
                serde_json::to_vec(&request.validation).unwrap(),
                serde_json::to_vec(&view).unwrap(),
            )
        };
        let plain = raw(2, Role::System, &contents);
        let legacy = evaluate(plain.clone());
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest([legacy.0.as_bytes(), &legacy.1, &legacy.2].concat())
            ),
            pin
        );
        assert_eq!(evaluate(marked(plain, code)), legacy);
    }
}

#[test]
fn host_frame_is_not_a_prompt_turn_or_floor_mark() {
    let (_, _, route, mut setup, settings) = fixture();
    setup.preset = "head".into();
    let mut session = Session::new(
        &route,
        &setup,
        crate::preset::features("head").unwrap(),
        None,
    );
    let mut answer = text(3, "answer");
    answer.role = Role::Assistant;
    session
        .index
        .extend([text(1, "real prompt"), frame(2, Role::User), answer]);
    session.floor_pending_for = Some((2, "steer".into()));
    session.conditions.last_prompt_tokens = Some(65_000);
    session.reading_stale = true;
    let _ = crate::test_log::logged(|| session.summary_due(&settings));
    assert!(
        session.floor_pending_for.is_none(),
        "mid-turn words cannot keep a prompt floor"
    );
    let entries = session.index.entries();
    assert!(!trigger::is_meaningful_user(&entries[1]));
    assert!(!lanes::starts_user_turn(&entries[1]));
    assert_eq!(crate::nudges::person_turns(entries), 1);
    assert_eq!(trigger::tail_start(entries, |_| 1_000, 1, 100, false), 1);
}

#[test]
fn host_frame_is_not_a_historian_split_but_can_end_or_open_coverage() {
    use validate::{validate_historian_output, StoredCompartmentRange, ValidateOptions};
    let entries = [
        text(1, "original prompt"),
        frame(2, Role::System),
        text(3, "next prompt"),
    ];
    let render = |entries: &[Entry]| chunk::build(entries, 10_000, counter()).unwrap().validation;
    let input = render(&entries);
    let xml = |ranges: &[(u64, u64)], next| {
        let body: String = ranges.iter().map(|(start, end)| format!(
            r#"<compartment start="{start}" end="{end}" title="Summary" episode_type="feature" importance="50"><p1>Covered discussion.</p1></compartment>"#
        )).collect();
        format!("<output><compartments>{body}</compartments><meta><unprocessed_from>{next}</unprocessed_from></meta></output>")
    };
    let options = ValidateOptions {
        in_emergency: true,
        ..Default::default()
    };
    let apply = |ranges, next| validate_historian_output(&xml(ranges, next), &input, &[], options);
    assert!(
        apply(&[(1, 1), (2, 3)], 4).is_err(),
        "cannot choose a compartment start on a frame"
    );
    assert!(
        apply(&[(1, 1)], 2).is_err(),
        "cannot defer coverage at a frame"
    );
    let covered = apply(&[(1, 2), (3, 3)], 4).unwrap();
    assert_eq!(covered.compartments[0].end_message, 2);
    let prior = [StoredCompartmentRange {
        start_message: 1,
        end_message: 1,
    }];
    let resumed =
        validate_historian_output(&xml(&[(2, 3)], 4), &render(&entries[1..]), &prior, options)
            .unwrap();
    assert_eq!(resumed.compartments[0].start_message, 2);
}

#[test]
fn host_frame_fills_held_metadata_without_changing_transcript() {
    let (mut session, _, _, _, _) = fixture();
    let plain = raw(1, Role::System, &stored());
    session
        .index
        .extend([plain.clone(), text(2, "next prompt")]);
    let cursor = session.index.cursor();
    let _ = session.index.summary_changes();
    let framed = marked(plain.clone(), CLAUDE_CODE_MID_TURN);
    assert_eq!(framed.digest, plain.digest);
    assert_eq!(framed.parts, plain.parts);
    assert!(matches!(
        session.index.extend([framed.clone()]),
        crate::index::Extend::Continued
    ));
    assert_eq!(session.index.cursor(), cursor);
    assert_eq!(session.index.at(1), Some(&framed));
    assert_eq!(session.index.summary_changes().1, Some(1));
    session.index.extend([plain]);
    assert_eq!(session.index.at(1), Some(&framed));
}

#[tokio::test]
async fn host_frame_survives_keep_reclaim_but_explicit_reduce_lands() {
    let (mut session, client, _, _, settings) = fixture();
    let mut keep = output_part("keep", 3);
    if let PartBody::Tool(tool) = &mut keep.body {
        tool.name = "ctx_keep".into();
    }
    session.index.extend([
        text(1, "real prompt"),
        frame(2, Role::System),
        Entry::new(3, "kept", Role::Assistant, 3, vec![keep]),
    ]);
    let drop_frame = |view: &View| {
        view.edits.iter().any(|edit| {
            matches!(
                &edit.op,
                EditOp::Replace { mid, .. } | EditOp::Drop { mid, .. } if mid == "steer"
            )
        })
    };
    let (view, _) = session.build(&settings, None, false, Some(&Default::default()));
    assert!(
        !view.as_ref().is_some_and(drop_frame),
        "ctx_keep must leave the frame alone"
    );
    let stamp = session
        .ctx_reduce(&client, &json!({"drop":"2"}))
        .await
        .unwrap();
    assert!(
        session.queued.contains(&("steer".into(), "words".into())),
        "{stamp}"
    );
    let (view, _) = session.build(&settings, None, true, None);
    assert!(
        view.as_ref().is_some_and(drop_frame),
        "the explicit stamp must land"
    );
}

#[test]
fn host_frame_does_not_count_as_reminder_reclaim_or_notice_age() {
    let (mut session, _, _, _, _) = fixture();
    let earlier = text(1, &"notice ".repeat(1_000)).with_notice(NoticeOrigin::new("module"));
    let framed = |n| {
        let mut row = frame(n, Role::User).with_notice(NoticeOrigin::new("module"));
        row.mid = format!("frame-{n}");
        row
    };
    session
        .index
        .extend([earlier, framed(2), framed(3), framed(4)]);
    let edited = lanes::Edited::of(None, &session.index, None);
    let protected_tools = Default::default();
    let context = lanes::Context {
        index: &session.index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: false,
        signed_floor: None,
    };
    let measurement = crate::nudges::measure(&context, None, &Default::default());
    assert_eq!(
        measurement.u,
        crate::tokens::part(&session.index.entries()[0].parts[0])
    );
    assert_eq!(lanes::notice_far_behind_bookmark(&context, 0), 0);
    assert!(lanes::age_sweep(&context, 0, u64::MAX, None)
        .iter()
        .all(|(key, _)| !key.0.starts_with("frame-")));
}

#[tokio::test]
async fn host_frame_expand_labels_only_the_words_without_losing_stored_text() {
    let (session, client, _, _, _) = fixture();
    let entry = frame(1, Role::System);
    *client.entries.lock().unwrap() = vec![entry.clone()];
    for input in [
        json!({"message":1}),
        json!({"tag":1}),
        json!({"start":1,"end":1}),
    ] {
        if input.get("tag").is_some() {
            client
                .pages
                .lock()
                .unwrap()
                .push_back(Ok(ReadPage::new(vec![entry.clone()], Head::new())));
        }
        let out = crate::expand::run(
            &client,
            &session.key,
            session.limits,
            &input,
            Some(1),
            counter(),
            crate::expand::NumbersUnknown {
                refused: &mut Default::default(),
                summarized: false,
            },
        )
        .await
        .unwrap();
        assert!(out.contains(&stored()), "{input}: {out}");
        assert!(
            out.contains(&format!("[person's mid-turn words]\n{WORDS}")),
            "{input}: {out}"
        );
        assert!(!out.contains("U (user)"), "{input}: {out}");
    }
}

#[tokio::test]
async fn marked_range_continuation_recovers_full_tool_output() {
    use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
    let (session, client, _, _, _) = fixture();
    let mut long = text(2, "long page");
    long.parts[0].body = PartBody::Text {
        text: "0123456789".repeat(5_800).into(),
    };
    let raw = format!("{}UNABRIDGED END", "payload ".repeat(1_000));
    let mut second = frame(3, Role::System);
    second.mid = "second-frame".into();
    second.parts.push(Part::new(
        "p",
        PartBody::Tool(
            ToolPart::new("call", "read", json!({}), ToolStatus::Completed).with_output(raw),
        ),
    ));
    *client.entries.lock().unwrap() = vec![frame(1, Role::System), long, second];
    let expand = async |input| {
        crate::expand::run(
            &client,
            &session.key,
            session.limits,
            &input,
            Some(3),
            counter(),
            crate::expand::NumbersUnknown {
                refused: &mut Default::default(),
                summarized: false,
            },
        )
        .await
        .unwrap()
    };
    let first = expand(json!({"start":1,"end":3})).await;
    let args = first
        .rsplit_once("Call again with start=")
        .expect("first page has a continuation")
        .1;
    let start: u64 = args.split_whitespace().next().unwrap().parse().unwrap();
    assert_eq!(start, 3, "the second page starts at the next marked entry");
    let next = expand(json!({"start":start,"end":3,"verbose":args.contains("verbose=true")})).await;
    assert!(
        next.contains("UNABRIDGED END"),
        "following the continuation must not request previews"
    );
}
