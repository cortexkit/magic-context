#[test]
fn tool_batch_admission_uses_earliest_call_not_the_tail_result() {
    use crate::edit_admission::{EditAdmission, Message, Part};
    let call = |id| json!({"kind":{"type":"tool_call","id":id,"name":"read","input":{},"provider_executed":false}});
    let result = |id| json!({"kind":{"type":"tool_result","id":id,"tool_name":"read","output":{"kind":{"type":"text","text":"output"}},"provider_executed":false}});
    let mut req: TransformRequest = serde_json::from_value(json!({
        "serializer_profile":"opencode-aisdk", "session_id":"compound", "render_config":"cfg",
        "messages":[
            {"mid":"assistant","ordinal":1,"ck":{"role":"assistant","content":[call("a"),{"kind":{"type":"reasoning","text":"kept","signature":"boundary"}},call("b")] }},
            {"mid":"result-a","ordinal":2,"ck":{"role":"tool","content":[result("a")] }},
            {"mid":"result-b","ordinal":3,"ck":{"role":"tool","content":[result("b")] }}
        ]
    })).unwrap();
    let frame = |boundary: usize| EditAdmission::new(&[
        Message { id: Some("assistant".into()), real_user: false, parts: (0..3).map(|i| Part { retained: i == boundary, anchor: (i == boundary).then(|| "boundary".into()) }).collect() },
        Message { id: Some("result-a".into()), real_user: false, parts: vec![] },
        Message { id: Some("result-b".into()), real_user: false, parts: vec![] },
    ], true);
    let (held, admitted) = tool_batch_admission(&req, &frame(1));
    assert!(admitted.is_empty(), "the earliest parallel call precedes kept thinking");
    assert_eq!(held, ["assistant#0", "assistant#2", "result-a#0", "result-b#0"].map(str::to_string).into_iter().collect());
    req.messages[0].ck.content.swap(0, 1);
    let (held, admitted) = tool_batch_admission(&req, &frame(0));
    assert!(held.is_empty());
    assert_eq!(admitted.len(), 4);
    req.messages.pop();
    let (held, admitted) = tool_batch_admission(&req, &frame(0));
    assert!(admitted.is_empty(), "an unanswered sibling holds the whole batch");
    assert_eq!(held.len(), 3);
}
