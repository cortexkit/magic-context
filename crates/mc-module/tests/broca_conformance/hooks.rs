use super::{harness::*, *};
use transform::{
    answer::{check_answer, HookAnswer},
    hook::HookCall,
    subscription::{Declaration, Op},
};

pub fn mixed_parts() -> Vec<Value> {
    vec![
        json!({"type":"reasoning","text":"§99§ signed reasoning","signature":"signed-unalterable"}),
        json!({"type":"text","text":"§12§ visible answer"}),
        json!({"type":"image","media_type":"image/png","data":"AA=="}),
        json!({"type":"tool_call","tool_call_id":"untouched","tool_name":"read","input":{"path":"§13§ file"}}),
        json!({"type":"text","text":"second text stays"}),
    ]
}

pub fn apply(parts: &[Value], answer: &Value) -> Vec<Value> {
    let answer: HookAnswer = serde_json::from_value(answer.clone()).unwrap();
    let mut parts = parts.to_vec();
    if let HookAnswer::Ops { ops } = answer {
        let texts: Vec<String> = parts
            .iter()
            .filter(|p| p["type"] == "text")
            .map(|p| p["text"].as_str().unwrap().into())
            .collect();
        let rendered = transform::answer::apply_ops(&texts, &ops).unwrap();
        for (part, text) in parts
            .iter_mut()
            .filter(|p| p["type"] == "text")
            .zip(rendered)
        {
            part["text"] = json!(text);
        }
    }
    parts
}

pub fn post_assistant(session: &str) -> Value {
    json!({"session":session,"harness":"broca","lineage_id":LINEAGE,"step_id":"assistant-step","hook":"post_assistant","blocks":["§12§ visible answer","second text stays"]})
}

pub fn pre_user(session: &str) -> Value {
    json!({"session":session,"harness":"broca","hook":"pre_user","step_id":"new-user","blocks":["first new block","last new block"],"params":{"nudge_every":1}})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_assistant_strips_only_addressed_text_preserves_signed_and_nontext_bytes() {
    let rig = Rig::start(None, false).await;
    let parts = mixed_parts();
    let before = parts
        .iter()
        .map(serde_json::to_vec)
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let answer = rig
        .method(
            &rig.identity(SESSION),
            "transform.hook",
            post_assistant(SESSION),
        )
        .await;
    assert_eq!(
        answer,
        json!({"answer":"ops","ops":[{"op":"replace","block":0,"value":"visible answer"}]})
    );
    let after = apply(&parts, &answer);
    assert_eq!(after[1]["text"], "visible answer");
    for index in [0, 2, 3, 4] {
        assert_eq!(
            serde_json::to_vec(&after[index]).unwrap(),
            before[index],
            "part {index} was not addressable"
        );
    }
    assert!(
        rig.script.callbacks().is_empty(),
        "post_assistant subject is not a transcript read"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pre_user_post_tool_append_only_new_content_and_disallowed_answer_is_unavailable() {
    let rig = Rig::start(None, false).await;
    let identity = rig.identity(SESSION);
    let old = vec![
        user(0, "frozen earlier user"),
        message(
            1,
            "assistant",
            json!([{"type":"text","text":"frozen earlier assistant"}]),
        ),
    ];
    let frozen = serde_json::to_vec(&old).unwrap();
    rig.script.transcript(old.clone());
    let declared = rig
        .method(&identity, "transform.declare", json!({"params":{}}))
        .await;
    let declaration: Declaration = serde_json::from_value(declared).unwrap();
    for request in [
        pre_user(SESSION),
        json!({"session":SESSION,"harness":"broca","lineage_id":LINEAGE,"hook":"post_tool","step_id":"new-tool","tool":"read","tool_call_id":"new-call","is_error":false,"blocks":["first new block","last new block"],"params":{"reminder_every":1}}),
    ] {
        let call: HookCall = serde_json::from_value(request.clone()).unwrap();
        let subscription = declaration
            .subscriptions
            .iter()
            .find(|s| s.hook == call.subject.hook())
            .unwrap();
        assert_eq!(
            subscription.on_unavailable,
            Some(transform::subscription::OnUnavailable::Pass)
        );
        let answer = rig.method(&identity, "transform.hook", request).await;
        let decoded: HookAnswer = serde_json::from_value(answer.clone()).unwrap();
        check_answer(&call.subject, &subscription.ops, None, &decoded).unwrap();
        let ops = answer["ops"].as_array().unwrap();
        let appends: Vec<_> = ops.iter().filter(|op| op["op"] == "append").collect();
        assert_eq!(appends.len(), 1, "{answer}");
        assert_eq!(
            appends[0]["block"], 1,
            "append must concatenate to the last existing text block"
        );
        let subjects = vec![
            json!({"type":"text","text":"first new block"}),
            json!({"type":"image","data":"AA=="}),
            json!({"type":"text","text":"last new block"}),
        ];
        let updated = apply(&subjects, &answer);
        assert_eq!(updated.len(), subjects.len());
        assert_eq!(updated[1], subjects[1]);
        assert!(updated[2]["text"]
            .as_str()
            .unwrap()
            .starts_with("last new block\n\n<system-reminder>"));
        assert_eq!(
            serde_json::to_vec(&rig.script.messages.lock().unwrap().clone()).unwrap(),
            frozen
        );
        let transform::answer::HookAnswer::Ops { ops } = decoded else {
            panic!("ops required");
        };
        let not_subscribed = check_answer(
            &call.subject,
            &[],
            None,
            &HookAnswer::Ops { ops: ops.clone() },
        )
        .unwrap_err();
        assert_eq!(not_subscribed.name(), "op_not_subscribed");
        assert_eq!(
            unavailable(&call, &[], &answer, &subjects),
            subjects,
            "disallowed answer must not be applied"
        );
        if call.subject.hook() == transform::subscription::Hook::PostTool {
            let bad_tool = check_answer(
                &call.subject,
                &subscription.ops,
                Some(&[Op::Append]),
                &HookAnswer::Ops { ops },
            )
            .unwrap_err();
            assert_eq!(bad_tool.name(), "op_not_accepted_by_tool");
        }
    }
}

// An advisory unavailable hook preserves the original subject; it does not
// apply a partly checked answer or replay the edit on old transcript content.
fn unavailable(
    call: &HookCall,
    subscribed: &[Op],
    answer: &Value,
    original: &[Value],
) -> Vec<Value> {
    let answer_typed = serde_json::from_value(answer.clone()).unwrap();
    if check_answer(&call.subject, subscribed, None, &answer_typed).is_err() {
        original.to_vec()
    } else {
        apply(original, answer)
    }
}
