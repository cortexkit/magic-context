//! What the emergency lane credits for a pass that moves the history cut.
//!
//! A cut leaves out every message through it, all of its parts included
//! (`EditOp::Cut`; the renderer in `cortexkit-compaction-view` drops each
//! cut message whole). The emergency lane's own transcript leaves those
//! messages out too (`lanes::Edited::of`), so the credit must count all of
//! what they cost in the previous request. Otherwise the remainder is
//! counted as fixed overhead and the lane drops more than the request needs.

use super::*;
use cortexkit_role_compaction::part::FileMedia;
use cortexkit_role_compaction::tokens::PartTokens;
use cortexkit_role_compaction::view::{InsertAt, InsertedMessage};

/// A 90k request: a 2k task, a 50k `kind` part in message "large", six tool
/// outputs (three of 5k, three of 1k) and 20k of fixed overhead. The usable
/// window is 100k, so the emergency ceiling is 65k.
fn session_with(kind: &str) -> (Session, Settings) {
    session_sized(kind, 50_000, 5_000)
}

/// As [`session_with`], with `large` tokens in message "large" and `big`
/// tokens in each of the three older tool outputs.
fn session_sized(kind: &str, large_tokens: u64, big: u64) -> (Session, Settings) {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.output_reserve = 0;
    session.conditions.last_prompt_tokens = Some(90_000);
    let mut task = text(1, "task");
    task.parts[0].tokens = Some(PartTokens::count(2_000));
    let mut large: Part = serde_json::from_value(serde_json::json!({
        "id":"p", "kind":kind, "text":"old assistant text", "text_bytes":200_000,
        "call_id":"c2", "name":"bash", "input":{}, "status":"completed",
        "output":"result", "output_bytes":200_000, "digest":""
    }))
    .unwrap();
    large.tag = Some(2);
    large.tokens = Some(if kind == "tool" {
        PartTokens::tool(0, large_tokens)
    } else {
        PartTokens::count(large_tokens)
    });
    let mut entries = vec![
        task,
        Entry::new(2, "large", Role::Assistant, 2, vec![large]),
    ];
    for tag in 3..=8 {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":"p", "kind":"tool", "call_id":format!("c{tag}"),
            "name":"bash", "input":{}, "status":"completed", "output":"result",
            "output_bytes":if tag <= 5 { 20_000 } else { 4_000 }, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part.tokens = Some(PartTokens::tool(0, if tag <= 5 { big } else { 1_000 }));
        entries.push(Entry::new(
            tag,
            format!("tool-{tag}"),
            Role::Assistant,
            tag,
            vec![part],
        ));
    }
    session.index.extend_counted(entries, Some("family"));
    session.index_ready = true;
    (session, settings)
}

/// A history head of two short messages, and a cut through `through`.
fn history(through: Option<&str>) -> Vec<EditOp> {
    let mut ops: Vec<_> = [(head::M0_ID, "baseline"), (head::M1_ID, "summary")]
        .into_iter()
        .map(|(id, text)| EditOp::Insert {
            at: InsertAt::Start,
            message: InsertedMessage::new(id, Role::User, vec![text.to_owned()]),
        })
        .collect();
    if let Some(through) = through {
        ops.push(EditOp::Cut {
            through: through.into(),
        });
    }
    ops
}

fn head_tokens(session: &Session) -> u64 {
    session.counter().count("baseline") + session.counter().count("summary")
}

fn tool_outputs(view: &View) -> Vec<&str> {
    view.edits
        .iter()
        .filter_map(|edit| match &edit.op {
            EditOp::Replace { mid, field, .. } if field == "output" && mid != "large" => {
                Some(mid.as_str())
            }
            _ => None,
        })
        .collect()
}

fn cuts_through(view: &View, mid: &str) -> bool {
    view.edits
        .iter()
        .any(|edit| matches!(&edit.op, EditOp::Cut { through } if through == mid))
}

/// The tool messages after the cut that any edit of `view` touches.
fn tools_touched(view: &View) -> BTreeSet<&str> {
    view.edits
        .iter()
        .filter_map(|edit| match &edit.op {
            EditOp::Replace { mid, .. } | EditOp::Drop { mid, .. } if mid.starts_with("tool-") => {
                Some(mid.as_str())
            }
            _ => None,
        })
        .collect()
}

#[test]
fn emergency_credit_review_an_over_limit_request_with_a_new_cut_still_drops_outputs() {
    // The over-limit ride estimates the next request at 144k, which will not fit the 100k window:
    // a 2k task, a 40k tool result in "large", tool outputs of 23k, 23k,
    // 23k, 1k, 1k and 1k, and 30k of fixed overhead.
    let (mut session, settings) = session_sized("tool", 40_000, 23_000);
    session.conditions.last_prompt_tokens = Some(95_000);
    let dir = tempfile::tempdir().unwrap();
    with_summary(&mut session, dir.path(), "large");
    let logs = crate::test_log::capture();
    let view = session
        .build(&settings, Some(144_000), false, None)
        .0
        .unwrap_or_else(|| panic!("built no view: {}", logs.text()));
    assert!(cuts_through(&view, "large"));
    // After the cut 102k remains besides the summary head: 72k of tool
    // outputs and 30k of fixed overhead, still over the window. Counting
    // the 40k result the cut removes as overhead (70k) puts the overhead
    // above the 65k ceiling, so the lane decides that no output drop can
    // help and takes none.
    assert!(
        !tools_touched(&view).is_empty(),
        "an over-limit request kept every output"
    );
}

#[test]
fn emergency_credit_review_a_new_cut_credits_the_tool_result_it_removes() {
    let (session, _) = session_with("tool");
    // The cut leaves out the 2k task and the whole 50k tool result.
    assert_eq!(
        session.emergency_removed_tokens(&history(Some("large")), &[]),
        52_000 - head_tokens(&session)
    );
}

#[test]
fn emergency_credit_review_a_new_cut_over_a_tool_result_takes_no_extra_outputs() {
    // 90k: a 2k task, a 50k tool result in "large", tool outputs of 10k,
    // 10k, 10k, 1k, 1k and 1k, and 5k of fixed overhead.
    let (mut session, settings) = session_sized("tool", 50_000, 10_000);
    let dir = tempfile::tempdir().unwrap();
    with_summary(&mut session, dir.path(), "large");
    let logs = crate::test_log::capture();
    let view = session
        .build(&settings, None, false, None)
        .0
        .unwrap_or_else(|| panic!("built no view: {}", logs.text()));
    assert!(cuts_through(&view, "large"));
    // After the cut 38k remains besides the small summary head: 33k of tool
    // outputs and 5k of fixed overhead. With the 65k ceiling the target is
    // 5k + 30% of 60k = 23k, so two 10k outputs are enough. Counting the 50k
    // result the cut removes as overhead (55k) puts the target at 58k of an
    // 88k prompt instead, and the lane takes all three.
    let taken = tool_outputs(&view);
    assert!(taken.len() <= 2, "took {taken:?}");
}

#[test]
fn emergency_credit_review_a_new_cut_credits_the_reasoning_it_removes() {
    let (session, _) = session_with("reasoning");
    assert_eq!(
        session.emergency_removed_tokens(&history(Some("large")), &[]),
        52_000 - head_tokens(&session)
    );
}

#[test]
fn emergency_credit_review_a_new_cut_credits_the_images_it_removes() {
    let (mut session, _) = session_with("text");
    let mut entries = session.index.entries().to_vec();
    for n in 0..10 {
        entries[0].parts.push(Part::new(
            format!("image-{n}").as_str(),
            PartBody::File(FileMedia::inline("image/png", Some(100))),
        ));
    }
    session.index = Index::default();
    session.index.extend_counted(entries, Some("family"));
    // Ten images at 1k each ride in the task message the cut leaves out.
    assert_eq!(
        session.emergency_removed_tokens(&history(Some("large")), &[]),
        52_000 + 10 * crate::tokens::IMAGE_TOKENS - head_tokens(&session)
    );
}

#[test]
fn emergency_credit_review_a_summarizer_turned_off_keeps_the_cut_and_its_credit() {
    let (mut session, settings) = session_with("text");
    let dir = tempfile::tempdir().unwrap();
    with_summary(&mut session, dir.path(), "large");
    // 50k is below the 85% force band (`pass::force_band`), so this first
    // view takes no output by emergency.
    session.conditions.last_prompt_tokens = Some(50_000);
    let logs = crate::test_log::capture();
    let first = session
        .build(&settings, None, false, None)
        .0
        .unwrap_or_else(|| panic!("built no view: {}", logs.text()));
    assert!(cuts_through(&first, "large"));
    assert!(tool_outputs(&first).is_empty());
    session.accept(first);
    session.conditions.last_prompt_tokens = Some(90_000);
    // A later Setup names a preset without a summarizer. Its history pass
    // renders no head and no cut, but summaries remain, so the next view
    // keeps the head and cut of the accepted view.
    session.features.summarizer = false;
    let (history, _) = session.history_ops(&settings, false);
    assert!(history.is_empty());
    session.queued.insert(("tool-3".into(), "p".into()));
    let queued = [EditOp::Drop {
        mid: "tool-3".into(),
        part: Some("p".into()),
    }];
    let credit = session.emergency_removed_tokens(&history, &queued);
    let next = session
        .build(&settings, None, false, None)
        .0
        .unwrap_or_else(|| panic!("built no view: {}", logs.text()));
    assert!(cuts_through(&next, "large"), "the next view keeps the cut");
    assert!(next.edits.iter().any(|edit| head::is_head(&edit.op)));
    // Only the queued 5k output leaves the request.
    assert_eq!(credit, 5_000);
}
