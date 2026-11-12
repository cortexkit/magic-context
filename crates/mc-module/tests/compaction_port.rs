//! Wire compatibility with runners that still use compaction contract 0.3.8.

use cortexkit_role_compaction::part::{
    Attachment, AttachmentItem, Delivered, FileMedia, Part, PartBody, ToolPart, ToolStatus,
};
use cortexkit_role_compaction::read::{Entry, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use mc_module::index::Index;
use mc_module::lanes::{self, Context, Edited, Shape};
use serde_json::json;

fn fixture() -> Vec<Entry> {
    let text = Part::new(
        "text",
        PartBody::Text {
            text: "Keep café 雪 and \"quotes\".\nNext line.".into(),
        },
    )
    .with_tag(1);
    let tool = ToolPart::new(
        "call",
        "read",
        json!({"path":"src/lib.rs","options":{"z":2,"a":1}}),
        ToolStatus::Completed,
    )
    .with_output("source contents\n")
    .with_output_bytes(16)
    .with_attachments(vec![Attachment::new(
        "image",
        AttachmentItem::File(FileMedia::inline("image/png", Some(1234))),
    )])
    .with_delivered(vec![Delivered::new(
        "prefrontal",
        "Remember the public API.",
    )]);
    vec![
        Entry::new(1, "m1", Role::User, 1, vec![text]),
        Entry::new(
            2,
            "m2",
            Role::Assistant,
            2,
            vec![Part::new("tool", PartBody::Tool(tool)).with_tag(2)],
        ),
        Entry::new(
            3,
            "m3",
            Role::User,
            3,
            vec![Part::new(
                "new",
                PartBody::Text {
                    text: "Continue.".into(),
                },
            )
            .with_tag(3)],
        ),
    ]
}

#[test]
fn view_bytes_and_checksum_match_compaction_0_3_8() {
    let entries = fixture();
    let mut index = Index::default();
    index.extend(entries.clone());
    let edited = Edited::default();
    let protected_tools = Default::default();
    let context = Context {
        index: &index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: false,
        signed_floor: None,
    };
    let (ops, covered) = lanes::drop_ops(
        &context,
        &[
            (("m1".into(), "text".into()), Shape::Requested),
            (("m2".into(), "tool".into()), Shape::Requested),
        ],
    );
    assert_eq!(covered.len(), 2);
    let view = mc_module::view_builder::next_view(
        None,
        &entries,
        ops,
        &ProviderRules::new(SignedParts::None, EditCost::Suffix),
        1,
        |_| false,
    )
    .unwrap()
    .unwrap();
    let bytes = serde_json::to_vec(&view).unwrap();
    // Captured on the pre-port commit with role-compaction 0.3.8 and
    // compaction-view 0.3.0, not computed by the implementation under test.
    assert_eq!(
        bytes,
        include_bytes!("../testdata/compaction-port-view-0.3.8.json")
    );
    assert_eq!(
        view.checksum,
        "5068a39db3292c3c8f8f09e0d6e854da2e2bf59771f84f59635552e508ee9c99"
    );
    let rendered = cortexkit_compaction_view::render::apply(&entries, &view).unwrap();
    assert!(!rendered.is_empty());
}

#[test]
fn duplicate_lookups_use_canonical_input_not_raw_json() {
    use cortexkit_role_compaction::ToolInput;
    let inputs = [
        r#"{ "path": "src/lib.rs", "options": { "z": 2, "a": 1 } }"#,
        r#"{"options":{"a":1,"z":2},"path":"src/lib.rs"}"#,
        // Since 0.4.0 the key uses JSON Canonicalization Scheme (JCS): number
        // spelling, too, does not make
        // a different tool call. This deliberately includes 1 versus 1.0.
        r#"{"path":"src/lib.rs","options":{"z":2.0,"a":1.0}}"#,
        r#"{"path":"different.rs","options":{"z":2,"a":1}}"#,
    ];
    let parts = inputs
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let input = ToolInput::from_text(*raw).unwrap();
            assert_eq!(input.as_str(), *raw);
            Part::new(
                format!("p{i}"),
                PartBody::Tool(
                    ToolPart::new(format!("c{i}"), "read", input, ToolStatus::Completed)
                        .with_output("contents"),
                ),
            )
            .with_tag(i as u64 + 1)
        })
        .collect();
    let mut index = Index::default();
    index.extend([Entry::new(1, "same-message", Role::Assistant, 1, parts)]);
    let edited = Edited::default();
    let protected_tools = Default::default();
    let context = Context {
        index: &index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: false,
        signed_floor: None,
    };
    assert_eq!(
        lanes::duplicate_lookups(&context, None),
        vec![
            (("same-message".into(), "p0".into()), Shape::Whole),
            (("same-message".into(), "p1".into()), Shape::Whole),
        ]
    );
}
