//! ck-mc's `pre_user` declaration for each preset, byte for byte: heads get
//! `append` for memory hints, and workers and readers subscribe to nothing.

use super::*;

#[test]
fn the_pre_user_declaration_is_append_for_heads_only() {
    for (preset, declared) in [
        (
            "head",
            r#"{"subscriptions":[{"hook":"pre_user","ops":["append"],"on_unavailable":"pass","budget_ms":1500}]}"#,
        ),
        ("worker", r#"{"subscriptions":[]}"#),
        ("reader", r#"{"subscriptions":[]}"#),
    ] {
        let declaration = declare(preset).expect("a preset ck-mc serves");
        assert_eq!(
            serde_json::to_string(&declaration).unwrap(),
            declared,
            "{preset}"
        );
    }
}

/// ck-mc never answers with a prepend: a person's message gets at most the
/// memory hint after it.
#[test]
fn a_hook_answer_never_prepends() {
    let hint = Addition {
        append: Some("\n\nhint".into()),
    };
    assert_eq!(
        serde_json::to_value(hook_answer(hint, 3)).unwrap(),
        serde_json::to_value(HookAnswer::Ops {
            ops: vec![Operation::Append {
                block: 2,
                text: "\n\nhint".into(),
                note: None,
            }],
        })
        .unwrap()
    );
    assert_eq!(
        serde_json::to_value(hook_answer(Addition::default(), 1)).unwrap(),
        serde_json::to_value(HookAnswer::Pass).unwrap()
    );
}
