use std::collections::HashSet;

use mc_module::protection_window::{CoordinateSpace, ProtectionWindow, TagNumber};
use mc_store::McTagRow;
use serde::Deserialize;

#[derive(Deserialize)]
struct Golden {
    schema: u32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    label: String,
    floor: u64,
    rows: Vec<Row>,
    expected_cutoff: Option<i64>,
    expected_protected_rows: Vec<String>,
    expected_protected_count: usize,
    expected_protected_mass: u64,
    cutoff_predicate_rows: Vec<String>,
}

#[derive(Deserialize)]
struct Row {
    tag_number: i64,
    row_identity: String,
    kind: String,
    #[serde(rename = "tokenCount")]
    token_count: Option<i64>,
}

#[test]
fn rust_walk_matches_typescript_generated_f1_through_f9_goldens() {
    let golden: Golden = serde_json::from_str(include_str!("../gen/protection-window-golden.json"))
        .expect("parse generated protection-window golden");
    assert_eq!(golden.schema, 1);
    assert!(golden.cases.len() >= 15);

    let mut opposed_tie_sets = Vec::new();
    for case in golden.cases {
        let rows = case
            .rows
            .iter()
            .map(|row| McTagRow {
                tag_number: row.tag_number,
                block_id: row.row_identity.clone(),
                kind: row.kind.clone(),
                token_count: row.token_count.unwrap_or(0),
                created_at_ms: 0,
                source_bytes: Default::default(),
            })
            .collect::<Vec<_>>();
        let window = ProtectionWindow::from_persisted_rows(&rows, case.floor);
        let actual_rows = window
            .member_rows
            .iter()
            .map(|row| format!("{}:{}", row.tag_number, row.block_id))
            .collect::<HashSet<_>>();
        let expected_rows = case
            .expected_protected_rows
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let predicate_rows = case
            .cutoff_predicate_rows
            .iter()
            .cloned()
            .collect::<HashSet<_>>();

        assert_eq!(
            window.cutoff.cutoff,
            case.expected_cutoff.map(TagNumber),
            "{} cutoff",
            case.label
        );
        assert_eq!(actual_rows, expected_rows, "{} TS row set", case.label);
        assert_eq!(window.cutoff.coordinate_space, CoordinateSpace::TagNumber);
        assert_eq!(
            window.tag_numbers.coordinate_space,
            CoordinateSpace::TagNumber
        );
        assert_eq!(
            window.row_identities.coordinate_space,
            CoordinateSpace::RowIdentity
        );
        assert_eq!(
            window.row_identities.block_ids,
            window
                .member_rows
                .iter()
                .map(|row| row.block_id.clone())
                .collect()
        );
        assert_eq!(
            window.tag_numbers.tag_numbers,
            window
                .member_rows
                .iter()
                .map(|row| TagNumber(row.tag_number))
                .collect()
        );
        let rust_predicate = rows
            .iter()
            .filter(|row| {
                row.kind == "tool"
                    && window
                        .cutoff
                        .cutoff
                        .is_some_and(|cutoff| row.tag_number >= cutoff.0)
            })
            .map(|row| format!("{}:{}", row.tag_number, row.block_id))
            .collect::<HashSet<_>>();
        assert_eq!(
            actual_rows, rust_predicate,
            "{} Rust cutoff predicate",
            case.label
        );
        assert_eq!(
            actual_rows, predicate_rows,
            "{} cutoff predicate row set",
            case.label
        );
        assert_eq!(
            window.status.protected_count, case.expected_protected_count,
            "{} count",
            case.label
        );
        assert_eq!(
            window.status.protected_mass, case.expected_protected_mass,
            "{} mass",
            case.label
        );
        if case.expected_cutoff.is_none() {
            for sentinel in [0, -1, i64::MAX] {
                assert_ne!(
                    window.cutoff.cutoff,
                    Some(TagNumber(sentinel)),
                    "{} must represent absence with Option::None",
                    case.label
                );
            }
        }
        if case.label.starts_with("F4 opposed tie") {
            opposed_tie_sets.push(actual_rows);
        }
    }

    assert_eq!(opposed_tie_sets.len(), 2);
    assert_eq!(opposed_tie_sets[0], opposed_tie_sets[1]);
}
