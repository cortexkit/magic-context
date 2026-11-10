use super::*;
use crate::summary::chunk::{self, Chunk, Lines};
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Role};

fn hidden(ordinal: u64) -> Entry {
    Entry::new(ordinal, format!("m{ordinal}"), Role::System, 0, vec![])
}

fn relay(ordinal: u64) -> Entry {
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::User,
        0,
        vec![Part::new(
            format!("p{ordinal}"),
            PartBody::Text {
                text: "<system-reminder>\nInbox: peer\n## Peer messages\nBROCA (pm_one): Check the parser.\n</system-reminder>".into(),
            },
        )],
    )
}

fn build(entries: &[Entry], mode: Lines) -> Chunk {
    chunk::build_with(
        entries,
        100_000,
        mode,
        crate::count::Counter::for_model(None),
    )
    .unwrap()
}

fn reply(ranges: &[(u64, u64)], unprocessed: u64) -> String {
    let body: String = ranges
        .iter()
        .map(|(start, end)| {
            format!(r#"<compartment start="{start}" end="{end}" title="Parser"><p1>Checked the parser.</p1><p2>Parser</p2><p3>Parser</p3><p4 /></compartment>"#)
        })
        .collect();
    format!("<output><compartments>{body}</compartments><unprocessed_from>{unprocessed}</unprocessed_from></output>")
}

fn validate(text: &str, chunk: &Chunk) -> Result<ValidatedChunk, HistorianValidationError> {
    validate_historian_output(
        text,
        &chunk.validation,
        &[],
        ValidateOptions {
            in_emergency: true,
            ..ValidateOptions::default()
        },
    )
}

#[test]
fn relay_after_hidden_prefix_extends_stored_start() {
    for mode in [Lines::Merged, Lines::PerMessage] {
        let chunk = build(&[hidden(1), relay(2)], mode);
        assert_eq!(
            chunk.input,
            "Messages 1-2:\n\n[2] PM from BROCA: Check the parser."
        );
        assert_eq!(chunk.validation.present_ordinals, vec![1, 2]);
        for start in [2, 1] {
            let validated = validate(&reply(&[(start, 2)], 3), &chunk).unwrap();
            assert_eq!(validated.compartments[0].start_message, 1);
            assert_eq!(validated.compartments[0].start_message_id, "m1");
            assert_eq!(validated.compartments[0].end_message, 2);
            assert_eq!(validated.unprocessed_from, 3);
        }
    }
}

#[test]
fn relay_after_mid_chunk_hidden_entry_extends_only_next_start() {
    for mode in [Lines::Merged, Lines::PerMessage] {
        let chunk = build(&[relay(1), hidden(2), relay(3)], mode);
        assert!(!chunk.input.contains("[2]"));
        for start in [3, 2] {
            let validated = validate(&reply(&[(1, 1), (start, 3)], 4), &chunk).unwrap();
            assert_eq!(validated.compartments[0].end_message, 1);
            assert_eq!(validated.compartments[1].start_message, 2);
            assert_eq!(validated.compartments[1].start_message_id, "m2");
        }
    }
}

#[test]
fn hidden_prefix_does_not_allow_skipping_a_printed_relay() {
    let chunk = build(&[hidden(1), relay(2), relay(3)], Lines::Merged);
    let error = validate(&reply(&[(3, 3)], 4), &chunk).unwrap_err();
    assert!(error
        .message
        .contains("gap before present message 3 (expected 1)"));
}

#[test]
fn unprocessed_boundary_may_skip_hidden_but_not_printed_ordinals() {
    let chunk = build(&[relay(1), hidden(2), relay(3), relay(4)], Lines::Merged);
    for unprocessed in [2, 3] {
        let validated = validate(&reply(&[(1, 1)], unprocessed), &chunk).unwrap();
        assert_eq!(validated.unprocessed_from, 2);
    }
    for unprocessed in [4, 5, 100] {
        let error = validate(&reply(&[(1, 1)], unprocessed), &chunk).unwrap_err();
        assert!(error
            .message
            .contains("does not match next uncovered message 2"));
    }
}

#[test]
fn ordinary_printed_range_still_demands_its_hidden_text_ordinal() {
    let ordinary = Entry::new(
        2,
        "m2",
        Role::User,
        0,
        vec![Part::new(
            "p2",
            PartBody::Text {
                text: "Check the parser.".into(),
            },
        )],
    );
    let chunk = build(&[hidden(1), ordinary], Lines::Merged);
    assert!(chunk.input.contains("[1-2] U:"));
    let error = validate(&reply(&[(2, 2)], 3), &chunk).unwrap_err();
    assert!(error
        .message
        .contains("gap before present message 2 (expected 1)"));
}

#[test]
fn hidden_compartment_end_remains_a_present_raw_boundary() {
    let chunk = build(&[hidden(1), relay(2), hidden(3)], Lines::Merged);
    let validated = validate(&reply(&[(2, 3)], 4), &chunk).unwrap();
    assert_eq!(validated.compartments[0].start_message_id, "m1");
    assert_eq!(validated.compartments[0].end_message_id, "m3");
    let partial = validate(&reply(&[(2, 2)], 3), &chunk).unwrap();
    assert_eq!(partial.unprocessed_from, 3);
}

#[test]
fn hidden_prefix_is_normalized_before_sparse_start_presence_check() {
    let chunk = build(&[hidden(1), relay(3)], Lines::Merged);
    let validated = validate(&reply(&[(2, 3)], 4), &chunk).unwrap();
    assert_eq!(validated.compartments[0].start_message, 1);
    assert_eq!(validated.compartments[0].start_message_id, "m1");
    assert!(validate(&reply(&[(3, 2)], 4), &chunk).is_err());
}

#[test]
fn turn_one_uses_extended_ranges_without_turning_hidden_lines_into_evidence() {
    let chunk = build(&[hidden(1), relay(2), relay(3)], Lines::Merged);
    let xml = reply(&[(2, 3)], 4).replace(
        "</output>",
        "<facts><PROJECT_RULES>\n* [at_compartment=1 messages=2-2] Check the parser.\n</PROJECT_RULES></facts></output>",
    );
    let envelope = serde_json::json!({"result": {"step": "turn_one", "xml": xml}}).to_string();
    let parsed = crate::summary::two_pass::turn_one::parse_reply(&envelope).unwrap();
    let validated = validate(&parsed, &chunk).unwrap();
    let ranges: Vec<_> = validated
        .compartments
        .iter()
        .map(|compartment| (compartment.start_message, compartment.end_message))
        .collect();
    assert_eq!(ranges, vec![(1, 3)]);
    let printed: Vec<_> = chunk
        .printed_blocks
        .iter()
        .map(|block| (block.start, block.end))
        .collect();
    let fact = &validated.facts[0];
    assert_eq!(
        resolve_fact_anchor(fact, &ranges, &printed, (1, 3))
            .unwrap()
            .block_indexes,
        vec![0]
    );
    let mut hidden_fact = fact.clone();
    hidden_fact.source_ranges = vec![FactSourceRange { start: 1, end: 1 }];
    assert!(resolve_fact_anchor(&hidden_fact, &ranges, &printed, (1, 3)).is_none());
}
