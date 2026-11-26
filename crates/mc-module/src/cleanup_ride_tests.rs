use super::*;
use cortexkit_role_compaction::part::{
    Attachment, AttachmentItem, FileMedia, ToolPart, ToolStatus,
};
use serde_json::{json, Value};

fn call(ordinal: u64, mid: &str, name: &str, status: ToolStatus, input: Value) -> Entry {
    let finished = crate::neutral::is_finished(&status);
    let mut tool = ToolPart::new(format!("c{ordinal}"), name, input, status);
    if finished {
        tool = tool.with_output("tool result").with_output_bytes(11);
    }
    let mut part = Part::new("p", PartBody::Tool(tool));
    part.tag = Some(ordinal);
    Entry::new(ordinal, mid, Role::Assistant, ordinal, vec![part])
}

fn old(name: &str, status: ToolStatus, input: Value) -> Entry {
    call(3, "old", name, status, input)
}

fn later(name: &str, status: ToolStatus, input: Value) -> Entry {
    call(4, "later", name, status, input)
}

fn filler(ordinal: u64, mid: &str) -> Entry {
    call(ordinal, mid, "bash", ToolStatus::Completed, json!({}))
}

fn transcript(old: Entry, later: Entry) -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    session.index.extend([
        text(1, "task"),
        assistant_text(2, "independent"),
        old,
        later,
        filler(5, "recent-a"),
        filler(6, "recent-b"),
    ]);
    session.index_ready = true;
    (session, client, settings)
}

fn whole_drop(mid: &str) -> EditOp {
    EditOp::Drop {
        mid: mid.into(),
        part: Some("p".into()),
    }
}

fn queue_independent(session: &mut Session) {
    session.queued.insert(("independent".into(), "p".into()));
}

fn with_independent_work(session: &mut Session, settings: &Settings) -> View {
    queue_independent(session);
    let logs = crate::test_log::capture();
    let view = session
        .build(settings, None, false, None)
        .0
        .unwrap_or_else(|| panic!("the queued stamp makes a view: {}", logs.text()));
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, .. } if mid == "independent" && field == "text"
    )));
    view
}

fn assert_old_result(view: &View, remove: bool) {
    assert_eq!(
        view.edits.iter().any(|edit| edit.op == whole_drop("old")),
        remove,
        "the older call should {}",
        if remove { "go whole" } else { "remain" }
    );
    assert!(
        !view.edits.iter().any(|edit| matches!(&edit.op,
            EditOp::Replace { mid, .. } if mid == "old"
        )),
        "the cleanup rules don't produce placeholders"
    );
}

fn assert_pair(old: Entry, later: Entry, remove: bool) {
    let (mut session, _, settings) = transcript(old, later);
    let view = with_independent_work(&mut session, &settings);
    assert_old_result(&view, remove);
    assert!(!view.edits.iter().any(|edit| edit.op == whole_drop("later")));
}

fn assert_read_pair(old_input: Value, later_input: Value, remove: bool) {
    assert_pair(
        old("mcp_Read", ToolStatus::Completed, old_input),
        later("read", ToolStatus::Completed, later_input),
        remove,
    );
}

fn compact_read(ordinal: u64, mid: &str, input: Value, output_bytes: Option<u64>) -> Entry {
    let mut entry = call(ordinal, mid, "read", ToolStatus::Completed, input);
    let PartBody::Tool(tool) = &mut entry.parts[0].body else {
        unreachable!()
    };
    tool.output = None;
    tool.output_bytes = output_bytes;
    entry
}

fn assert_wider_read_with_size(size: Option<u64>, end: u64, remove: bool) {
    assert_pair(
        old(
            "read",
            ToolStatus::Completed,
            json!({"path":"f", "startLine":200, "endLine":250}),
        ),
        compact_read(
            4,
            "later",
            json!({"path":"f", "startLine":1, "endLine":end}),
            size,
        ),
        remove,
    );
}

#[test]
fn cleanup_ride_wider_read_at_or_above_the_byte_cap_cannot_replace_a_narrower_read() {
    for bytes in [30_000, 30_001] {
        assert_wider_read_with_size(Some(bytes), 500, false);
    }
}

#[test]
fn cleanup_ride_wider_read_below_the_byte_cap_can_replace_a_narrower_read() {
    assert_wider_read_with_size(Some(29_999), 2_000, true);
}

#[test]
fn cleanup_ride_wider_request_over_2000_lines_cannot_replace_a_narrower_read() {
    assert_wider_read_with_size(Some(10), 2_001, false);
}

#[test]
fn cleanup_ride_exact_repeats_do_not_need_a_size_or_line_limit() {
    let input = json!({"path":"f", "startLine":1, "endLine":5_000});
    for (older, newer) in [
        (Some(0), Some(40_000)),
        (Some(40_000), None),
        (None, Some(0)),
    ] {
        assert_pair(
            compact_read(3, "old", input.clone(), older),
            compact_read(4, "later", input.clone(), newer),
            true,
        );
    }
}

#[test]
fn cleanup_ride_wider_read_with_unknown_or_zero_bytes_cannot_replace_a_narrower_read() {
    for size in [None, Some(0)] {
        assert_wider_read_with_size(size, 500, false);
    }
}

#[test]
fn cleanup_ride_a_removable_whole_read_cannot_be_a_wider_witness() {
    let wider = json!({"path":"f", "startLine":1, "endLine":500});
    let (mut session, _, settings) = transcript(
        old(
            "read",
            ToolStatus::Completed,
            json!({"path":"f", "startLine":200, "endLine":250}),
        ),
        compact_read(4, "later", wider.clone(), Some(10_000)),
    );
    session
        .index
        .extend([compact_read(7, "repeat", wider, Some(40_000))]);
    let view = with_independent_work(&mut session, &settings);
    assert!(view.edits.iter().any(|edit| edit.op == whole_drop("later")));
    assert_old_result(&view, false);
}

#[test]
fn cleanup_ride_removes_an_identical_earlier_read() {
    assert_read_pair(
        json!({"path":"f", "offset":4, "limit":10}),
        json!({"filePath":"f", "startLine":4, "endLine":13}),
        true,
    );
}

#[test]
fn cleanup_ride_removes_a_read_covered_by_a_wider_read() {
    assert_read_pair(
        json!({"path":"f", "offset":4, "limit":10}),
        json!({"file_path":"f", "startLine":2, "endLine":16}),
        true,
    );
}

#[test]
fn cleanup_ride_default_read_covers_a_range_through_line_2000() {
    assert_read_pair(
        json!({"path":"f", "startLine":1500, "endLine":2000}),
        json!({"path":"f"}),
        true,
    );
}

#[test]
fn cleanup_ride_keeps_a_range_not_covered_by_one_later_read() {
    assert_read_pair(
        json!({"path":"f", "startLine":4, "endLine":14}),
        json!({"path":"f", "startLine":4, "endLine":13}),
        false,
    );
    assert_read_pair(
        json!({"path":"f", "startLine":4, "endLine":14}),
        json!({"path":"f", "startLine":5, "endLine":14}),
        false,
    );
}

#[test]
fn cleanup_ride_keeps_a_range_past_the_default_read_length() {
    assert_read_pair(
        json!({"path":"f", "startLine":1500, "endLine":2001}),
        json!({"path":"f"}),
        false,
    );
}

#[test]
fn cleanup_ride_keeps_reads_with_unreadable_or_invalid_ranges() {
    let valid = json!({"path":"f"});
    for invalid in [
        json!({"path":"f", "offset":"not a number"}),
        json!({"path":"f", "limit":null}),
        json!({"path":"f", "startLine":0}),
        json!({"path":"f", "endLine":-1}),
        json!({"path":"f", "startLine":2, "endLine":1}),
        json!({"path":"f", "startLine":u64::MAX, "limit":2}),
    ] {
        assert_read_pair(valid.clone(), invalid.clone(), false);
        assert_read_pair(invalid, valid.clone(), false);
    }
}

#[test]
fn cleanup_ride_keeps_reads_with_different_path_strings() {
    assert_read_pair(json!({"path":"./f"}), json!({"path":"/project/f"}), false);
}

#[test]
fn cleanup_ride_keeps_reads_when_either_result_has_a_file_attachment() {
    for mime_type in ["text/plain", "image/png"] {
        for attach_to_old in [true, false] {
            let mut old = old("read", ToolStatus::Completed, json!({"path":"f"}));
            let mut later = later("read", ToolStatus::Completed, json!({"path":"f"}));
            let attached = if attach_to_old { &mut old } else { &mut later };
            let PartBody::Tool(tool) = &mut attached.parts[0].body else {
                unreachable!()
            };
            tool.set_attachments(vec![Attachment::new(
                "file",
                AttachmentItem::File(FileMedia::inline(mime_type, Some(4))),
            )]);
            assert_pair(old, later, false);
        }
    }
}

#[test]
fn cleanup_ride_keeps_both_kinds_of_call_if_the_witness_was_already_removed() {
    for status in [ToolStatus::Completed, ToolStatus::Error] {
        let (mut session, _, settings) = transcript(
            old("read", status, json!({"path":"f"})),
            later("read", ToolStatus::Completed, json!({"path":"f"})),
        );
        let previous = session.seal(vec![whole_drop("later")], &[]).unwrap();
        session.accept(previous.clone());
        session.settle_unconfirmed(Some(&previous.applied()), &[]);
        let view = with_independent_work(&mut session, &settings);
        assert!(view.edits.iter().any(|edit| edit.op == whole_drop("later")));
        assert_old_result(&view, false);
    }
}

#[test]
fn cleanup_ride_removes_file_tool_errors_after_same_path_success() {
    for tool in ["write", "edit", "read"] {
        assert_pair(
            old(
                &format!("mcp_{}", tool.to_uppercase()),
                ToolStatus::Error,
                json!({"file_path":"f", "content":"failed input"}),
            ),
            later(
                tool,
                ToolStatus::Completed,
                json!({"filePath":"f", "content":"changed input"}),
            ),
            true,
        );
    }
}

#[test]
fn cleanup_ride_keeps_a_file_tool_error_after_a_different_tool_or_path_succeeds() {
    for (tool, path) in [("edit", "f"), ("write", "other")] {
        assert_pair(
            old("write", ToolStatus::Error, json!({"path":"f"})),
            later(tool, ToolStatus::Completed, json!({"path":path})),
            false,
        );
    }
}

#[test]
fn cleanup_ride_removes_a_lookup_error_after_identical_success() {
    assert_pair(
        old(
            "MCP_GREP",
            ToolStatus::Error,
            json!({"pattern":"needle", "path":"src"}),
        ),
        later(
            "grep",
            ToolStatus::Completed,
            json!({"path":"src", "pattern":"needle"}),
        ),
        true,
    );
}

#[test]
fn cleanup_ride_keeps_a_lookup_error_after_different_success() {
    assert_pair(
        old(
            "grep",
            ToolStatus::Error,
            json!({"pattern":"needle", "path":"src"}),
        ),
        later(
            "grep",
            ToolStatus::Completed,
            json!({"pattern":"another", "path":"src"}),
        ),
        false,
    );
}

#[test]
fn cleanup_ride_keeps_even_an_identical_bash_error_after_success() {
    for command in ["test", "unrelated"] {
        assert_pair(
            old("bash", ToolStatus::Error, json!({"command":"test"})),
            later("bash", ToolStatus::Completed, json!({"command":command})),
            false,
        );
    }
}

#[test]
fn cleanup_ride_running_denied_and_unknown_are_neither_successes_nor_failures() {
    for status in [
        ToolStatus::Running,
        ToolStatus::Denied,
        ToolStatus::Unknown("queued".into()),
    ] {
        for (older, newer) in [
            (ToolStatus::Completed, status.clone()),
            (ToolStatus::Error, status.clone()),
            (status, ToolStatus::Completed),
        ] {
            assert_pair(
                old("read", older, json!({"path":"f"})),
                later("read", newer, json!({"path":"f"})),
                false,
            );
        }
    }
}

#[test]
fn cleanup_ride_an_error_is_not_a_successful_read_or_retry() {
    for older in [ToolStatus::Completed, ToolStatus::Error] {
        assert_pair(
            old("read", older, json!({"path":"f"})),
            later("read", ToolStatus::Error, json!({"path":"f"})),
            false,
        );
    }
}

#[test]
fn cleanup_ride_leaves_both_kinds_of_call_in_the_protected_tail() {
    for status in [ToolStatus::Completed, ToolStatus::Error] {
        let (mut session, _, mut settings) = transcript(
            old("read", status, json!({"path":"f"})),
            later("read", ToolStatus::Completed, json!({"path":"f"})),
        );
        // The prefix-changing ride bypasses the need for another lane's
        // work, but not the protected tail. A large protected-token budget
        // puts every tool call in this fixture inside that tail.
        settings.protected_tokens = Some(10_000);
        assert!(session.build(&settings, None, true, None).0.is_none());
    }
}

#[test]
fn cleanup_ride_does_not_use_a_witness_removed_in_the_same_view() {
    for status in [ToolStatus::Completed, ToolStatus::Error] {
        let (mut session, _, settings) = transcript(
            old("read", status, json!({"path":"f"})),
            later(
                "read",
                ToolStatus::Completed,
                json!({"path":"f", "extra":"x".repeat(1_025)}),
            ),
        );
        session.index.extend([filler(7, "recent-c")]);
        session.queued.insert(("later".into(), "p".into()));
        let view = with_independent_work(&mut session, &settings);
        assert!(view.edits.iter().any(|edit| edit.op == whole_drop("later")));
        assert_old_result(&view, false);
    }
}

#[test]
fn cleanup_ride_respects_protected_tools_and_keep_selections() {
    for status in [ToolStatus::Completed, ToolStatus::Error] {
        let make_session = || {
            transcript(
                old("read", status.clone(), json!({"path":"f"})),
                later("read", ToolStatus::Completed, json!({"path":"f"})),
            )
        };
        let (mut session, _, mut settings) = make_session();
        settings.protected_tools.insert("read".into(), 2);
        assert_old_result(&with_independent_work(&mut session, &settings), false);

        let (mut session, _, settings) = make_session();
        let keep = BTreeSet::from([("old".into(), "p".into())]);
        queue_independent(&mut session);
        let view = session
            .build(&settings, None, false, Some(&keep))
            .0
            .unwrap();
        assert_old_result(&view, false);
    }
}

#[tokio::test]
async fn cleanup_ride_only_publishes_and_records_candidates_with_independent_work() {
    for (tool, status) in [
        ("read", ToolStatus::Completed),
        ("write", ToolStatus::Error),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(crate::store::Store::open(&dir.path().join("sessions.db")).unwrap());
        let (mut session, client, settings) = transcript(
            old(tool, status, json!({"path":"f"})),
            later(tool, ToolStatus::Completed, json!({"path":"f"})),
        );
        session.set_store(Some(store.clone()));
        let before = store.session_rows(&session.key).unwrap();
        let version = session.version;
        assert!(session.build(&settings, None, false, None).0.is_none());
        assert_eq!(session.version, version);
        assert!(session.latest.is_none());
        assert!(session.next_covered.is_empty());
        assert!(client.offered.lock().unwrap().is_empty());
        assert_eq!(store.session_rows(&session.key).unwrap(), before);

        let view = with_independent_work(&mut session, &settings);
        assert_old_result(&view, true);
        let old = ("old".into(), "p".into());
        assert!(session.next_covered.contains(&old));
        session.publish(&client, view).await;
        assert_eq!(client.offered.lock().unwrap().len(), 1);
        assert!(session.edited(None).covers("old", "p"));
    }
}

#[test]
fn cleanup_ride_can_join_an_already_changed_provider_prefix() {
    for status in [ToolStatus::Completed, ToolStatus::Error] {
        let (mut session, _, settings) = transcript(
            old("read", status, json!({"path":"f"})),
            later("read", ToolStatus::Completed, json!({"path":"f"})),
        );
        let view = session
            .build(&settings, None, true, None)
            .0
            .expect("the runner already rewrote the prefix");
        assert_old_result(&view, true);
    }
}
