use super::*;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../testdata/runner-todo-transcript.json")).unwrap()
}

fn entries(value: &Value) -> Vec<codec::InboundMessage> {
    serde_json::from_value(value.clone()).unwrap()
}

fn entry(ordinal: u64, role: &str, content: Value) -> codec::InboundMessage {
    serde_json::from_value(json!({
        "ordinal": ordinal,
        "mid": format!("m{ordinal}"),
        "message": {"role": role, "content": content},
    }))
    .unwrap()
}

fn todowrite(ordinal: u64, id: &str, todos: Value) -> codec::InboundMessage {
    entry(
        ordinal,
        "assistant",
        json!([{"type":"tool_call","tool_call_id":id,"tool_name":"todowrite","input":{"todos":todos}}]),
    )
}

fn outcome(ordinal: u64, id: &str, output: Value, is_error: bool) -> codec::InboundMessage {
    entry(
        ordinal,
        "tool",
        json!([{"type":"tool_result","tool_call_id":id,"output":output,"is_error":is_error}]),
    )
}

fn active(label: &str) -> Value {
    json!([{"content": label, "status": "in_progress"}])
}

fn state(label: &str) -> String {
    format!(r#"[{{"content":"{label}","status":"in_progress","priority":"medium"}}]"#)
}

#[test]
fn the_fixture_call_and_its_result_give_the_todo_state_set_state() {
    let fixture = fixture();
    let mut scan = TodoScan::default();
    let derived = scan_status_messages(&mut scan, "L", &entries(&fixture["transcript"]))
        .unwrap()
        .expect("a todowrite call with a successful result");
    let expected = fixture["expected_state_json"].as_str().unwrap();
    assert_eq!(derived.state_json, expected);
    assert_eq!(derived.owner_message_id, "m1");
    assert_eq!(derived.state_hash, sha256_hex(expected.as_bytes()));
    // todo_state.set normalizes its own state_json to the same string.
    let set_body = serde_json::to_string(&fixture["todo_state_set"]["todos"]).unwrap();
    assert_eq!(
        crate::injection::normalize_todo_state_json(&set_body).as_deref(),
        Some(expected)
    );
}

#[test]
fn a_todowrite_whose_result_failed_changes_nothing() {
    let mut scan = TodoScan::default();
    let messages = [
        todowrite(0, "ok", active("kept")),
        outcome(1, "ok", json!({"kind":"text","text":"1 todos"}), false),
        todowrite(2, "bad", active("rejected")),
        outcome(
            3,
            "bad",
            json!({"kind":"error","message":"todowrite failed"}),
            true,
        ),
        todowrite(4, "denied", active("denied")),
        outcome(
            5,
            "denied",
            json!({"kind":"denied","reason":"no permission"}),
            false,
        ),
    ];
    let derived = scan_status_messages(&mut scan, "L", &messages)
        .unwrap()
        .unwrap();
    assert_eq!(derived.state_json, state("kept"));
    assert_eq!(derived.owner_message_id, "m0");
    assert!(scan.pending.is_empty());
}

#[test]
fn a_call_without_its_result_waits_for_it() {
    let mut scan = TodoScan::default();
    let first = [todowrite(0, "later", active("pending"))];
    assert_eq!(scan_status_messages(&mut scan, "L", &first).unwrap(), None);
    assert!(scan.pending.contains_key("later"));
    // The next step carries the result; the held call now counts.
    let second = [outcome(
        1,
        "later",
        json!({"kind":"json","value":{}}),
        false,
    )];
    let derived = scan_status_messages(&mut scan, "L", &second)
        .unwrap()
        .unwrap();
    assert_eq!(derived.state_json, state("pending"));
    assert_eq!(derived.owner_message_id, "m0");
}

#[test]
fn the_newest_successful_result_wins_and_rescans_are_noops() {
    let mut scan = TodoScan::default();
    let messages = [
        todowrite(0, "a", active("first")),
        outcome(1, "a", json!({"kind":"text","text":"ok"}), false),
        todowrite(2, "b", active("second")),
        outcome(3, "b", json!({"kind":"text","text":"ok"}), false),
    ];
    let derived = scan_status_messages(&mut scan, "L", &messages)
        .unwrap()
        .unwrap();
    assert_eq!(derived.state_json, state("second"));
    assert_eq!(scan.through, Some(3));
    assert_eq!(
        scan_status_messages(&mut scan, "L", &messages).unwrap(),
        None
    );
}

#[test]
fn lookalike_tools_and_malformed_todos_are_ignored() {
    let mut scan = TodoScan::default();
    let messages = [
        entry(
            0,
            "assistant",
            json!([{"type":"tool_call","tool_call_id":"mcp","tool_name":"mcp_Todowrite","input":{"todos":active("mcp")}}]),
        ),
        outcome(1, "mcp", json!({"kind":"text","text":"ok"}), false),
        todowrite(2, "broken", json!([{"content": 7}])),
        outcome(3, "broken", json!({"kind":"text","text":"ok"}), false),
    ];
    assert_eq!(
        scan_status_messages(&mut scan, "L", &messages).unwrap(),
        None
    );
}

#[test]
fn a_new_lineage_restarts_the_cursor() {
    let mut scan = TodoScan::default();
    let parent = [
        todowrite(0, "a", active("parent")),
        outcome(1, "a", json!({"kind":"text","text":"ok"}), false),
    ];
    scan_status_messages(&mut scan, "L", &parent).unwrap();
    let child = [
        todowrite(0, "c", active("child")),
        outcome(1, "c", json!({"kind":"text","text":"ok"}), false),
    ];
    let derived = scan_status_messages(&mut scan, "L2", &child)
        .unwrap()
        .unwrap();
    assert_eq!(derived.state_json, state("child"));
    assert_eq!(scan.lineage, "L2");
}
