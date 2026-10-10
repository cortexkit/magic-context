use mc_module::edit_admission::{BlockPos, EditAdmission, EditCoord, Frame, Message, Part};
use serde_json::Value;

fn anchor(part: &Value) -> Option<String> {
    let redacted = part["redacted"] == true
        || matches!(
            part["type"].as_str(),
            Some("redacted_thinking" | "redacted_reasoning")
        );
    let fields = if redacted {
        vec![
            &part["data"],
            &part["metadata"]["anthropic"]["redactedData"],
            &part["thinkingSignature"],
            &part["thinking"],
        ]
    } else {
        vec![
            &part["metadata"]["anthropic"]["signature"],
            &part["signature"],
            &part["thinkingSignature"],
        ]
    };
    fields
        .into_iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
}

fn message(m: &Value) -> Message {
    let parts = m["parts"].as_array().cloned().unwrap_or_default();
    let carrier = !parts.is_empty()
        && parts.iter().all(|p| {
            p["synthetic"] == true
                || p["ignored"] == true
                || matches!(
                    p["type"].as_str(),
                    Some("tool_result" | "toolResult" | "tool-result")
                )
        });
    Message {
        id: m["id"].as_str().map(str::to_owned),
        real_user: m["role"] == "user"
            && m["synthetic"] != true
            && !carrier
            && !m["id"].as_str().unwrap_or("").starts_with("synth-user-"),
        parts: parts
            .iter()
            .map(|p| Part {
                anchor: anchor(p),
                retained: m["role"] == "assistant"
                    && p["retained"] != false
                    && matches!(
                        p["type"].as_str(),
                        Some("reasoning" | "thinking" | "redacted_thinking" | "redacted_reasoning")
                    ),
            })
            .collect(),
    }
}

fn coord(c: &Value) -> EditCoord<'_> {
    match c["kind"].as_str().unwrap() {
        "prefix" => EditCoord::Prefix,
        "append" => EditCoord::Append {
            after_mid: c["afterId"].as_str(),
        },
        "message" => EditCoord::Message {
            mid: c["id"].as_str(),
            block: if c["block"] == "whole" {
                BlockPos::Whole
            } else {
                BlockPos::Index(c["block"].as_u64().unwrap() as usize)
            },
        },
        _ => panic!("unknown coordinate"),
    }
}

#[test]
fn shared_admission_corpus() {
    let corpus: Vec<Value> =
        serde_json::from_str(include_str!("../testdata/edit-admission.json")).unwrap();
    assert_eq!(corpus.len(), 23);
    for row in corpus {
        let messages: Vec<_> = row["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(message)
            .collect();
        let admission = EditAdmission::new(&messages, row["prefixBound"] != false);
        for edit in row["edits"].as_array().unwrap() {
            assert_eq!(
                admission.admit(coord(&edit["coord"])),
                edit["admit"].as_bool().unwrap(),
                "{}: {}",
                row["name"],
                edit
            );
        }
        if let Some(compound) = row["compound"].as_array() {
            for edit in compound {
                let coords: Vec<_> = edit["coords"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(coord)
                    .collect();
                assert_eq!(
                    admission.admit_compound(&coords),
                    edit["admit"].as_bool().unwrap(),
                    "{}: {}",
                    row["name"],
                    edit
                );
            }
        }
    }
}

#[test]
fn frame_cost_is_tail_bounded() {
    let mut messages: Vec<_> = (0..2000)
        .map(|i| Message {
            id: Some(format!("m-{i}")),
            real_user: i == 0,
            parts: vec![],
        })
        .collect();
    messages[1996].parts.push(Part {
        retained: true,
        anchor: Some("signed".into()),
    });
    let mut visits = 0;
    let admission = EditAdmission::from_reverse(
        messages.iter().rev().inspect(|_| visits += 1).cloned(),
        true,
    );
    assert!(matches!(admission.frame, Frame::Boundary { .. }));
    assert_eq!(visits, 4);
    messages[1996].parts.clear();
    messages[1990].real_user = true;
    visits = 0;
    let admission = EditAdmission::from_reverse(
        messages.iter().rev().inspect(|_| visits += 1).cloned(),
        true,
    );
    assert!(matches!(admission.frame, Frame::None));
    assert_eq!(visits, 10);
}
