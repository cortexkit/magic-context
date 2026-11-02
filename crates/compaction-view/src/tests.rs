//! Tests for applying views and checking provider rules.

use ck_contract_draft::part::{
    Attachment, AttachmentItem, Delivered, FileMedia, OutputFormat, Part, PartBody, Seal, ToolPart,
    ToolStatus,
};
use ck_contract_draft::read::{entry_digest, Entry, Role};
use ck_contract_draft::rules::{EditCost, ProviderRules, RuleBreak, SignedParts};
use ck_contract_draft::view::{
    AppliedView, Edit, EditOp, InsertAt, InsertedMessage, View, ViewRefusal,
};
use serde_json::json;

use crate::render::{apply, apply_edits, check_carried, Source};
use crate::rules::{check, invalid_signed_parts};

fn entry(
    ordinal: u64,
    mid: &str,
    role: Role,
    parts: Vec<Part>,
    generated_under: Option<u64>,
) -> Entry {
    Entry {
        ordinal,
        mid: mid.into(),
        role,
        notice: None,
        written_at: ordinal * 1_000,
        digest: entry_digest(role, None, &parts),
        parts,
        usage: None,
        generated_under: generated_under.map(|version| AppliedView {
            version,
            checksum: format!("checksum-{version}"),
        }),
    }
}

fn text(id: &str, tag: u64, value: &str) -> Part {
    Part::new(
        id,
        Some(tag),
        Seal::None,
        PartBody::Text { text: value.into() },
    )
}

fn signed(id: &str) -> Part {
    Part::new(
        id,
        None,
        Seal::Signed,
        PartBody::Reasoning {
            text: Some("thinking".into()),
            text_bytes: Some(8),
        },
    )
}

fn tool_body(id: &str, status: ToolStatus) -> ToolPart {
    ToolPart {
        call_id: format!("call-{id}"),
        name: "edit".into(),
        input: json!({"path": "a.rs", "old_string": "x".repeat(100), "count": 3}),
        provider_executed: false,
        status,
        output: (status != ToolStatus::Running).then(|| "done".into()),
        output_format: OutputFormat::Text,
        output_bytes: (status != ToolStatus::Running).then_some(4),
        attachments: vec![Attachment {
            id: "img-1".into(),
            item: AttachmentItem::File(FileMedia::inline("image/png", Some(2048))),
        }],
        approval: None,
        delivered: vec![],
    }
}

fn tool(id: &str, tag: u64, status: ToolStatus) -> Part {
    Part::new(
        id,
        Some(tag),
        Seal::None,
        PartBody::Tool(tool_body(id, status)),
    )
}

fn drop_part(since: u64, mid: &str, part: &str) -> Edit {
    Edit::new(
        since,
        EditOp::Drop {
            mid: mid.into(),
            part: Some(part.into()),
        },
    )
}

fn drop_message(since: u64, mid: &str) -> Edit {
    Edit::new(
        since,
        EditOp::Drop {
            mid: mid.into(),
            part: None,
        },
    )
}

fn replace(
    since: u64,
    entries: &[Entry],
    mid: &str,
    part: &str,
    field: &str,
    value: serde_json::Value,
) -> Edit {
    let expect = entries
        .iter()
        .find(|entry| entry.mid == mid)
        .and_then(|entry| entry.parts.iter().find(|candidate| candidate.id == part))
        .map(|found| found.digest.clone())
        .unwrap();
    Edit::new(
        since,
        EditOp::Replace {
            mid: mid.into(),
            part: part.into(),
            field: field.into(),
            value,
            expect,
        },
    )
}

fn insert(since: u64, at: InsertAt, id: &str) -> Edit {
    Edit::new(
        since,
        EditOp::Insert {
            at,
            message: InsertedMessage {
                id: id.into(),
                role: Role::User,
                texts: vec!["<session-history>...</session-history>".into()],
            },
        },
    )
}

fn transcript() -> Vec<Entry> {
    vec![
        entry(0, "u1", Role::User, vec![text("t1", 1, "please fix")], None),
        entry(
            1,
            "a1",
            Role::Assistant,
            vec![
                signed("r1"),
                text("t2", 2, "looking"),
                tool("k1", 3, ToolStatus::Completed),
            ],
            None,
        ),
        entry(2, "u2", Role::User, vec![text("t3", 4, "go on")], None),
        entry(
            3,
            "a2",
            Role::Assistant,
            vec![signed("r2"), tool("k2", 5, ToolStatus::Running)],
            None,
        ),
    ]
}

const BOUND: ProviderRules = ProviderRules {
    signed_parts: SignedParts::Bound,
    history_edit_cost: EditCost::Suffix,
};

#[test]
fn an_empty_view_renders_the_transcript_unchanged() {
    let entries = transcript();
    let rendered = apply(&entries, &View::seal(1, vec![])).unwrap();
    assert_eq!(rendered.len(), entries.len());
    for (message, entry) in rendered.iter().zip(&entries) {
        assert_eq!(message.parts, entry.parts);
    }
}

#[test]
fn drops_remove_parts_and_a_message_left_empty_disappears() {
    let entries = transcript();
    let edits = vec![drop_part(1, "a1", "k1"), drop_part(1, "u2", "t3")];
    let rendered = apply_edits(&entries, &edits).unwrap();
    let mids: Vec<_> = rendered
        .iter()
        .map(|message| match &message.source {
            Source::Entry { mid, .. } => mid.as_str(),
            Source::Inserted { id } => id.as_str(),
        })
        .collect();
    assert_eq!(mids, ["u1", "a1", "a2"]);
    let a1: Vec<_> = rendered[1]
        .parts
        .iter()
        .map(|part| part.id.as_str())
        .collect();
    assert_eq!(a1, ["r1", "t2"]);

    let rendered = apply_edits(&entries, &[drop_message(1, "a1")]).unwrap();
    assert_eq!(rendered.len(), 3);
}

#[test]
fn replaces_change_one_field_and_keep_id_and_tag() {
    let entries = transcript();
    let edits = vec![
        replace(1, &entries, "u1", "t1", "text", json!("[dropped §1§]")),
        replace(1, &entries, "a1", "k1", "output", json!("[dropped §3§]")),
        replace(1, &entries, "a1", "k1", "input.old_string", json!("xxx…")),
        replace(1, &entries, "a1", "k1", "attachments", json!([])),
    ];
    let rendered = apply_edits(&entries, &edits).unwrap();
    let PartBody::Text { text } = &rendered[0].parts[0].body else {
        panic!()
    };
    assert_eq!(text, "[dropped §1§]");
    let replaced = &rendered[1].parts[2];
    assert_eq!((replaced.id.as_str(), replaced.tag), ("k1", Some(3)));
    let PartBody::Tool(tool) = &replaced.body else {
        panic!()
    };
    assert_eq!(tool.output.as_deref(), Some("[dropped §3§]"));
    assert_eq!(tool.input["old_string"], "xxx…");
    assert_eq!(tool.input["path"], "a.rs");
    assert!(tool.attachments.is_empty());
    assert_ne!(replaced.digest, entries[1].parts[2].digest);
}

#[test]
fn bad_edits_are_refused_by_name() {
    let entries = transcript();
    let stale = Edit::new(
        1,
        EditOp::Replace {
            mid: "u1".into(),
            part: "t1".into(),
            field: "text".into(),
            value: json!("x"),
            expect: "old".into(),
        },
    );
    assert!(matches!(
        apply_edits(&entries, &[stale]),
        Err(ViewRefusal::StalePart { .. })
    ));
    for edit in [
        replace(1, &entries, "a1", "r1", "text", json!("x")),
        replace(1, &entries, "a1", "k1", "input.count", json!("x")),
        replace(1, &entries, "a1", "k1", "input.missing", json!("x")),
        replace(1, &entries, "a1", "k1", "attachments", json!(["img-2"])),
        replace(1, &entries, "u1", "t1", "text", json!(7)),
    ] {
        assert!(
            matches!(
                apply_edits(&entries, std::slice::from_ref(&edit)),
                Err(ViewRefusal::BadField { .. })
            ),
            "{edit:?}"
        );
    }
    assert!(matches!(
        apply_edits(&entries, &[drop_part(1, "a2", "k2")]),
        Err(ViewRefusal::RunningTool { .. })
    ));
    assert!(matches!(
        apply_edits(&entries, &[drop_message(1, "a2")]),
        Err(ViewRefusal::RunningTool { .. })
    ));
    assert!(matches!(
        apply_edits(&entries, &[drop_part(1, "nope", "t1")]),
        Err(ViewRefusal::UnknownMessage { .. })
    ));
    assert!(matches!(
        apply_edits(&entries, &[drop_part(1, "u1", "nope")]),
        Err(ViewRefusal::UnknownPart { .. })
    ));
    assert!(matches!(
        apply_edits(
            &entries,
            &[
                drop_part(1, "u1", "t1"),
                replace(1, &entries, "u1", "t1", "text", json!("x"))
            ]
        ),
        Err(ViewRefusal::Conflict { .. })
    ));
    assert!(matches!(
        apply_edits(
            &entries,
            &[
                replace(1, &entries, "u1", "t1", "text", json!("x")),
                replace(1, &entries, "u1", "t1", "text", json!("y"))
            ]
        ),
        Err(ViewRefusal::Conflict { .. })
    ));
    assert!(matches!(
        apply_edits(&entries, &[insert(1, InsertAt::Before("nope".into()), "h")]),
        Err(ViewRefusal::UnknownAnchor { .. })
    ));
    assert!(matches!(
        apply_edits(
            &entries,
            &[
                insert(1, InsertAt::Start, "h"),
                insert(1, InsertAt::Start, "h")
            ]
        ),
        Err(ViewRefusal::DuplicateInsert { .. })
    ));
}

#[test]
fn inserts_render_where_they_are_anchored_even_before_a_dropped_message() {
    let entries = transcript();
    let edits = vec![
        insert(1, InsertAt::Start, "m0"),
        drop_message(1, "u1"),
        drop_message(1, "a1"),
        insert(1, InsertAt::Before("u2".into()), "m1"),
    ];
    let rendered = apply_edits(&entries, &edits).unwrap();
    let sources: Vec<_> = rendered
        .iter()
        .map(|message| message.source.clone())
        .collect();
    assert_eq!(
        sources,
        [
            Source::Inserted { id: "m0".into() },
            Source::Inserted { id: "m1".into() },
            Source::Entry {
                ordinal: 2,
                mid: "u2".into()
            },
            Source::Entry {
                ordinal: 3,
                mid: "a2".into()
            },
        ]
    );
    assert_eq!(rendered[0].parts[0].tag, None);
}

#[test]
fn a_view_with_a_wrong_checksum_is_refused() {
    let entries = transcript();
    let mut view = View::seal(2, vec![drop_part(2, "u1", "t1")]);
    assert!(apply(&entries, &view).is_ok());
    view.edits.clear();
    assert!(matches!(
        apply(&entries, &view),
        Err(ViewRefusal::BadChecksum)
    ));
}

#[test]
fn the_wire_shape_puts_since_and_op_side_by_side() {
    let edit = drop_part(3, "u1", "t1");
    assert_eq!(
        serde_json::to_value(&edit).unwrap(),
        json!({"since": 3, "op": "drop", "mid": "u1", "part": "t1"})
    );
    let view = View::seal(
        3,
        vec![edit, insert(3, InsertAt::Before("u2".into()), "m1")],
    );
    let back: View = serde_json::from_value(serde_json::to_value(&view).unwrap()).unwrap();
    assert_eq!(back, view);
    assert!(back.verify());
}

#[test]
fn since_values_must_match_the_previous_view() {
    let carried = drop_part(2, "u1", "t1");
    let previous = View::seal(2, vec![carried.clone()]);
    // Carried unchanged, plus new edits from a version the runner skipped and
    // from the view's own version.
    let next = View::seal(
        5,
        vec![carried, drop_part(4, "a1", "k1"), drop_part(5, "u2", "t3")],
    );
    assert!(check_carried(Some(&previous), &next).is_ok());
    // A new edit that claims to be as old as the previous view.
    let backdated = View::seal(5, vec![drop_part(2, "a1", "k1")]);
    assert_eq!(
        check_carried(Some(&previous), &backdated),
        Err(ViewRefusal::BadSince)
    );
    // An edit from the future.
    let future = View::seal(5, vec![drop_part(6, "a1", "k1")]);
    assert_eq!(
        check_carried(Some(&previous), &future),
        Err(ViewRefusal::BadSince)
    );
    assert_eq!(
        check_carried(None, &View::seal(1, vec![drop_part(0, "a1", "k1")])),
        Err(ViewRefusal::BadSince)
    );
}

/// u1 | a1: r1 (signed), t2, k1 | u2 | a3: r3 (signed), t5 | u4 | a5: r5 (signed), t7
fn signed_transcript(generated: [u64; 3]) -> Vec<Entry> {
    vec![
        entry(0, "u1", Role::User, vec![text("t1", 1, "start")], None),
        entry(
            1,
            "a1",
            Role::Assistant,
            vec![
                signed("r1"),
                text("t2", 2, "one"),
                tool("k1", 3, ToolStatus::Completed),
            ],
            Some(generated[0]),
        ),
        entry(2, "u2", Role::User, vec![text("t4", 4, "more")], None),
        entry(
            3,
            "a3",
            Role::Assistant,
            vec![signed("r3"), text("t5", 5, "two")],
            Some(generated[1]),
        ),
        entry(4, "u4", Role::User, vec![text("t6", 6, "more")], None),
        entry(
            5,
            "a5",
            Role::Assistant,
            vec![signed("r5"), text("t7", 7, "three")],
            Some(generated[2]),
        ),
    ]
}

fn invalid(entries: &[Entry], edits: &[Edit]) -> Vec<String> {
    invalid_signed_parts(entries, edits, &BOUND)
        .into_iter()
        .map(|(_, part)| part)
        .collect()
}

#[test]
fn an_edit_before_a_signed_part_invalidates_it_only_if_it_came_later() {
    let entries = signed_transcript([0, 0, 0]);
    let edits = vec![drop_part(1, "a1", "k1")];
    assert_eq!(invalid(&entries, &edits), ["r3", "r5"]);
    assert_eq!(
        check(&entries, &edits, &BOUND),
        Err(RuleBreak::SignedPartInvalid {
            mid: "a3".into(),
            part: "r3".into()
        })
    );

    // r5 was generated under view 1, which already held that drop.
    let entries = signed_transcript([0, 0, 1]);
    assert_eq!(invalid(&entries, &edits), ["r3"]);

    // An edit after every signed part touches none of them.
    let entries = signed_transcript([0, 0, 0]);
    assert!(invalid(&entries, &[drop_part(1, "a5", "t7")]).is_empty());

    // The same rules with no signature binding never object.
    let free = ProviderRules {
        signed_parts: SignedParts::None,
        ..BOUND
    };
    assert!(check(&entries, &edits, &free).is_ok());
}

#[test]
fn an_insert_right_before_a_message_invalidates_its_own_signed_part() {
    let entries = signed_transcript([0, 0, 0]);
    let edits = vec![insert(1, InsertAt::Before("a3".into()), "note")];
    assert_eq!(invalid(&entries, &edits), ["r3", "r5"]);
}

#[test]
fn a_new_history_head_at_the_start_invalidates_every_older_signed_part() {
    let entries = signed_transcript([1, 1, 2]);
    let edits = vec![insert(2, InsertAt::Start, "m0")];
    assert_eq!(invalid(&entries, &edits), ["r1", "r3"]);
}

#[test]
fn signed_parts_may_be_left_out_only_as_an_oldest_run() {
    let entries = signed_transcript([0, 0, 0]);
    // Leaving out the oldest is fine.
    assert!(invalid(&entries, &[drop_part(1, "a1", "r1")]).is_empty());
    // Leaving out the oldest two is fine.
    assert!(invalid(
        &entries,
        &[drop_part(1, "a1", "r1"), drop_part(1, "a3", "r3")]
    )
    .is_empty());
    // Leaving out the middle one invalidates the newer one.
    assert_eq!(invalid(&entries, &[drop_part(1, "a3", "r3")]), ["r5"]);
    // A gap made before r5 was generated was already part of its history.
    let entries = signed_transcript([0, 0, 1]);
    assert!(invalid(&entries, &[drop_part(1, "a3", "r3")]).is_empty());
}

/// The same transcript in compact form, as a notice carries it.
fn compact(entries: &[Entry]) -> Vec<Entry> {
    entries
        .iter()
        .map(|entry| Entry {
            parts: entry.parts.iter().map(Part::compact).collect(),
            ..entry.clone()
        })
        .collect()
}

#[test]
fn edits_computed_from_the_compact_form_apply_to_the_full_one_and_back() {
    let full = transcript();
    let short = compact(&full);
    // Computed by a provider that only holds the compact form.
    let edits = vec![
        replace(1, &short, "a1", "k1", "output", json!("[dropped §3§]")),
        replace(1, &short, "u1", "t1", "text", json!("fix it")),
        drop_part(1, "a1", "r1"),
    ];
    let on_full = apply_edits(&full, &edits).unwrap();
    let on_short = apply_edits(&short, &edits).unwrap();
    assert_eq!(on_full.len(), on_short.len());
    for (left, right) in on_full.iter().zip(&on_short) {
        let ids = |message: &crate::render::RenderedMessage| {
            message
                .parts
                .iter()
                .map(|part| (part.id.clone(), part.tag))
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(left), ids(right));
    }
    let PartBody::Tool(tool) = &on_short[1].parts[1].body else {
        panic!()
    };
    assert_eq!(tool.output.as_deref(), Some("[dropped §3§]"));
    assert_eq!(tool.output_bytes, Some("[dropped §3§]".len() as u64));
    assert_eq!(
        invalid_signed_parts(&full, &edits, &BOUND),
        invalid_signed_parts(&short, &edits, &BOUND)
    );
}

#[test]
fn an_inserted_message_carrying_a_tag_prefix_is_refused() {
    let entries = transcript();
    let mut tagged = insert(1, InsertAt::Start, "head");
    if let EditOp::Insert { message, .. } = &mut tagged.op {
        message.texts = vec!["summary that quotes \u{a7}3\u{a7} by mistake".into()];
    }
    assert_eq!(
        apply_edits(&entries, &[tagged]),
        Err(ViewRefusal::TaggedInsert { id: "head".into() })
    );
    assert!(apply_edits(&entries, &[insert(1, InsertAt::Start, "head")]).is_ok());
}

#[test]
fn a_replace_may_show_its_own_number_and_numbers_the_original_had_but_no_other() {
    let mut entries = transcript();
    entries[0].parts[0] = text("t1", 1, "please drop \u{a7}7\u{a7} and fix");
    let own = replace(
        1,
        &entries,
        "u1",
        "t1",
        "text",
        json!("[dropped \u{a7}1\u{a7}]"),
    );
    assert!(apply_edits(&entries, &[own]).is_ok());
    let kept = replace(
        1,
        &entries,
        "u1",
        "t1",
        "text",
        json!("drop \u{a7}7\u{a7}, fix"),
    );
    assert!(apply_edits(&entries, &[kept]).is_ok());
    let foreign = replace(1, &entries, "u1", "t1", "text", json!("see \u{a7}9\u{a7}"));
    assert_eq!(
        apply_edits(&entries, &[foreign]),
        Err(ViewRefusal::ForeignTag {
            mid: "u1".into(),
            part: "t1".into(),
            field: "text".into(),
            tag: 9,
        })
    );
}

#[test]
fn sealed_and_provider_run_parts_can_only_be_dropped() {
    let mut entries = transcript();
    entries[0].parts[0] = Part::new(
        "t1",
        Some(1),
        Seal::Signed,
        PartBody::Text {
            text: "signed text".into(),
        },
    );
    let mut hosted = tool_body("k9", ToolStatus::Completed);
    hosted.provider_executed = true;
    entries[1].parts[2] = Part::new("k1", None, Seal::None, PartBody::Tool(hosted));

    for (mid, part, field) in [("u1", "t1", "text"), ("a1", "k1", "output")] {
        let edit = replace(1, &entries, mid, part, field, json!("short"));
        assert_eq!(
            apply_edits(&entries, &[edit]),
            Err(ViewRefusal::BadField {
                mid: mid.into(),
                part: part.into(),
                field: field.into(),
            })
        );
        assert!(apply_edits(&entries, &[drop_part(1, mid, part)]).is_ok());
    }
}

#[test]
fn a_replace_of_delivered_keeps_only_the_named_sends() {
    let mut entries = transcript();
    let mut body = tool_body("k1", ToolStatus::Completed);
    body.delivered = vec![
        Delivered::new("magic-context", Some("mc.reduce".into()), "first".into()),
        Delivered::new("prefrontal", None, "second".into()),
    ];
    entries[1].parts[2] = Part::new("k1", Some(3), Seal::None, PartBody::Tool(body));
    let keep_second = replace(1, &entries, "a1", "k1", "delivered", json!([1]));
    let rendered = apply_edits(&entries, &[keep_second]).unwrap();
    let PartBody::Tool(tool) = &rendered[1].parts[2].body else {
        panic!("the tool part stays a tool part");
    };
    assert_eq!(tool.delivered.len(), 1);
    assert_eq!(tool.delivered[0].text.as_deref(), Some("second"));

    for bad in [json!([2]), json!([0, 0]), json!(["0"])] {
        let edit = replace(1, &entries, "a1", "k1", "delivered", bad);
        assert!(matches!(
            apply_edits(&entries, &[edit]),
            Err(ViewRefusal::BadField { .. })
        ));
    }
}

#[test]
fn a_signed_text_part_is_bound_like_signed_reasoning() {
    // Gemini signs text and tool calls, not only reasoning. A kept signed
    // text part is invalidated by a later edit before it, like reasoning.
    let mut entries = transcript();
    entries[2].parts[0] = Part::new(
        "t3",
        Some(4),
        Seal::Signed,
        PartBody::Text {
            text: "go on".into(),
        },
    );
    let invalid = invalid_signed_parts(&entries, &[drop_part(1, "u1", "t1")], &BOUND);
    assert!(invalid.contains(&("u2".to_owned(), "t3".to_owned())));
}

/// The JSON test vectors under `vectors/cases.json`, for runners that use the
/// library through WebAssembly or implement the rules themselves. Each case
/// is generated here and its output computed by [`crate::vectors::call`].
/// Set `UPDATE_VECTORS=1` to rewrite the file after a deliberate change; the
/// test otherwise fails when the file and the library disagree.
mod vector_file {
    use super::*;
    use crate::vectors::{call, Vector, FUNCTIONS};
    use serde_json::{json, Value};

    /// A transcript as a runner presents it: ordinals count from 1.
    /// u1 | a1: r1 (signed), t2, k1 (edit with an image) | u2 | a2: r2 (signed), t5
    fn transcript(generated: [u64; 2]) -> Vec<Entry> {
        vec![
            entry(1, "u1", Role::User, vec![text("t1", 1, "please fix")], None),
            entry(
                2,
                "a1",
                Role::Assistant,
                vec![
                    signed("r1"),
                    text("t2", 2, "looking"),
                    tool("k1", 3, ToolStatus::Completed),
                ],
                Some(generated[0]),
            ),
            entry(3, "u2", Role::User, vec![text("t4", 4, "go on")], None),
            entry(
                4,
                "a2",
                Role::Assistant,
                vec![signed("r2"), text("t5", 5, "done")],
                Some(generated[1]),
            ),
        ]
    }

    fn running() -> Vec<Entry> {
        vec![
            entry(1, "u1", Role::User, vec![text("t1", 1, "run it")], None),
            entry(
                2,
                "a1",
                Role::Assistant,
                vec![tool("k1", 2, ToolStatus::Running)],
                None,
            ),
        ]
    }

    fn only_image() -> Vec<Entry> {
        let mut body = tool_body("k1", ToolStatus::Completed);
        body.output = Some(String::new());
        body.output_bytes = Some(0);
        vec![
            entry(1, "u1", Role::User, vec![text("t1", 1, "screenshot")], None),
            entry(
                2,
                "a1",
                Role::Assistant,
                vec![Part::new("k1", Some(2), Seal::None, PartBody::Tool(body))],
                None,
            ),
        ]
    }

    fn head(since: u64) -> Edit {
        Edit::new(
            since,
            EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage {
                    id: "m0".into(),
                    role: Role::User,
                    texts: vec!["<session-history>summary</session-history>".into()],
                },
            },
        )
    }

    fn cut(since: u64, through: &str) -> Edit {
        Edit::new(
            since,
            EditOp::Cut {
                through: through.into(),
            },
        )
    }

    fn free() -> ProviderRules {
        ProviderRules {
            signed_parts: SignedParts::None,
            ..BOUND
        }
    }

    fn cases() -> Vec<(&'static str, &'static str, Value)> {
        let t = transcript([0, 0]);
        let plan = |edits: Vec<Edit>| json!({"entries": t, "edits": edits});
        let placeholder = replace(1, &t, "u2", "t4", "text", json!("[dropped §4§]"));
        let own_output = replace(1, &t, "a1", "k1", "output", json!("[dropped §3§]"));
        let marker = replace(
            1,
            &t,
            "a1",
            "k1",
            "input.old_string",
            json!("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…[truncated]"),
        );
        let foreign = replace(1, &t, "u2", "t4", "text", json!("see §9§"));
        let stale = {
            let mut edit = replace(1, &t, "u2", "t4", "text", json!("[dropped §4§]"));
            if let EditOp::Replace { expect, .. } = &mut edit.op {
                *expect = "0".repeat(64);
            }
            edit
        };
        let tagged_head = Edit::new(
            1,
            EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage {
                    id: "m0".into(),
                    role: Role::User,
                    texts: vec!["§2§ summary".into()],
                },
            },
        );
        let view = View::seal(1, vec![drop_part(1, "a1", "k1")]);
        let mut bad_checksum = view.clone();
        bad_checksum.checksum = "0".repeat(64);
        let previous = View::seal(1, vec![drop_part(1, "a1", "k1")]);
        let carried = View::seal(2, vec![drop_part(1, "a1", "k1"), drop_part(2, "u2", "t4")]);
        let backdated = View::seal(2, vec![drop_part(1, "a1", "k1"), drop_part(1, "u2", "t4")]);
        let image = only_image();
        let mut unnumbered = transcript([0, 0]);
        for entry in &mut unnumbered {
            for part in &mut entry.parts {
                part.tag = None;
            }
        }
        vec![
            ("an empty view keeps everything", "plan", plan(vec![])),
            (
                "a dropped part is left out",
                "plan",
                plan(vec![drop_part(1, "a1", "k1")]),
            ),
            (
                "a dropped message is left out",
                "plan",
                plan(vec![drop_message(1, "u2")]),
            ),
            (
                "a text placeholder replaces the text and is final",
                "plan",
                plan(vec![placeholder]),
            ),
            (
                "a tool result may show its own number",
                "plan",
                plan(vec![own_output]),
            ),
            (
                "an edit marker shortens one argument",
                "plan",
                plan(vec![marker]),
            ),
            (
                "a history head at the start with a cut",
                "plan",
                plan(vec![head(1), cut(1, "a1")]),
            ),
            (
                "an edit naming a message the transcript lacks is refused",
                "plan",
                plan(vec![drop_message(1, "gone")]),
            ),
            (
                "a replace computed from another part is refused",
                "plan",
                plan(vec![stale]),
            ),
            (
                "an inserted message may not carry a tag prefix",
                "plan",
                plan(vec![tagged_head]),
            ),
            (
                "a replace may not show another part's number",
                "plan",
                plan(vec![foreign]),
            ),
            (
                "two edits on one part that cannot both hold are refused",
                "plan",
                plan(vec![
                    drop_part(1, "u2", "t4"),
                    replace(1, &t, "u2", "t4", "text", json!("x")),
                ]),
            ),
            (
                "a running tool cannot be dropped",
                "plan",
                json!({"entries": running(), "edits": [drop_part(1, "a1", "k1")]}),
            ),
            (
                "a result with only an image renders a label",
                "plan",
                json!({"entries": image, "edits": []}),
            ),
            (
                "a sealed view applies",
                "apply",
                json!({"entries": t, "view": view}),
            ),
            (
                "a view whose checksum does not match is refused",
                "apply",
                json!({"entries": t, "view": bad_checksum}),
            ),
            (
                "edits for messages a revert removed are skipped",
                "edits_for_transcript",
                json!({"entries": &t[..2], "edits": [drop_part(1, "a1", "k1"), drop_part(1, "u2", "t4")]}),
            ),
            (
                "a new view repeats the previous one's edits",
                "check_carried",
                json!({"previous": previous, "next": carried}),
            ),
            (
                "a backdated edit is refused",
                "check_carried",
                json!({"previous": previous, "next": backdated}),
            ),
            (
                "an edit before a signed part made after it invalidates it",
                "check_rules",
                json!({"entries": t, "edits": [drop_part(1, "a1", "k1")], "rules": BOUND}),
            ),
            (
                "an edit the signed part was generated under is fine",
                "check_rules",
                json!({"entries": transcript([0, 1]), "edits": [drop_part(1, "a1", "k1")], "rules": BOUND}),
            ),
            (
                "the oldest signed part may be left out",
                "check_rules",
                json!({"entries": t, "edits": [drop_part(1, "a1", "r1")], "rules": BOUND}),
            ),
            (
                "a history head invalidates every older signed part",
                "check_rules",
                json!({"entries": t, "edits": [head(1)], "rules": BOUND}),
            ),
            (
                "without bound signatures nothing is invalid",
                "check_rules",
                json!({"entries": t, "edits": [drop_part(1, "a1", "k1")], "rules": free()}),
            ),
            (
                "current Claude families are bound",
                "rules_defaults",
                json!({"model": "claude-opus-5-5"}),
            ),
            (
                "other models are not",
                "rules_defaults",
                json!({"model": "gpt-6.1"}),
            ),
            (
                "numbers count from the checkpoint",
                "assign_tags",
                json!({"checkpoint": 41, "entries": unnumbered}),
            ),
            (
                "numbers are found anywhere in a text",
                "tag_numbers_in",
                json!({"text": "[dropped §12§] then §3§, but not §§ or §7"}),
            ),
            (
                "a reply's own prefix is split off",
                "clean_reply",
                json!({"text": "§12§ Done."}),
            ),
            (
                "numbers inside a reply are removed",
                "clean_reply",
                json!({"text": "§12§ §13§ Dropped §4§ and §5\">§6§ as asked."}),
            ),
            (
                "a section reference keeps its number but not its sign",
                "clean_reply",
                json!({"text": "See §5.1 of the spec."}),
            ),
            (
                "an entry's checksum",
                "entry_digest",
                json!({"role": "user", "parts": [text("t1", 1, "please fix")]}),
            ),
            (
                "a part's checksum covers its seal and body",
                "body_digest",
                json!({"seal": "signed", "kind": "reasoning", "text": "thinking", "text_bytes": 8}),
            ),
            (
                "a view's checksum",
                "seal_view",
                json!({"version": 3, "edits": [drop_part(2, "a1", "k1")]}),
            ),
        ]
    }

    fn generate() -> Vec<Vector> {
        cases()
            .into_iter()
            .map(|(name, function, input)| Vector {
                name: name.into(),
                function: function.into(),
                output: call(function, input.clone()),
                input,
            })
            .collect()
    }

    #[test]
    fn the_vector_file_matches_the_library() {
        let vectors = generate();
        for vector in &vectors {
            assert!(
                FUNCTIONS.iter().any(|(name, _)| *name == vector.function),
                "{}",
                vector.function
            );
            assert!(
                vector.output.get("error").is_none(),
                "{}: {}",
                vector.name,
                vector.output
            );
        }
        // Every function has at least one case.
        for (function, _) in FUNCTIONS {
            assert!(
                vectors.iter().any(|vector| vector.function == *function),
                "no vector for {function}"
            );
        }
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("vectors/cases.json");
        let written = serde_json::to_string_pretty(&vectors).unwrap() + "\n";
        if std::env::var_os("UPDATE_VECTORS").is_some() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &written).unwrap();
        }
        let file = std::fs::read_to_string(&path)
            .expect("vectors/cases.json is missing; run the tests with UPDATE_VECTORS=1");
        assert_eq!(
            file, written,
            "vectors/cases.json is stale; run with UPDATE_VECTORS=1"
        );
        // Read back as a runner reads them: from JSON, each input gives its
        // output.
        let read: Vec<Vector> = serde_json::from_str(&file).unwrap();
        for vector in read {
            assert_eq!(
                call(&vector.function, vector.input),
                vector.output,
                "{}",
                vector.name
            );
        }
    }
}
