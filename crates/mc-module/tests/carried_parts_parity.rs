use std::collections::{BTreeMap, BTreeSet};

use cortexkit_role_compaction::part::{PartBody, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{Entry, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::tokens::PartTokens;
use mc_module::count::Counter;
use mc_module::index::Index;
use mc_module::{lanes, neutral, summary::chunk, tokens, view_builder};
use serde_json::json;
use sha2::{Digest, Sha256};

fn generated_entries(seed: u64) -> Vec<Entry> {
    let mut tag = 0;
    let mut random = seed + 1;
    (1..=48)
        .map(|ordinal| {
            // Fixed sequence so the same cases can be run against another revision.
            random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
            let pick = random >> 32;
            let make_tagged = |id, tag: &mut u64, body| {
                *tag += 1;
                neutral::part(id, Some(*tag), Seal::None, body)
            };
            let mut role = Role::Assistant;
            let parts = match pick % 12 {
                0 => Vec::new(), // Keep rows that the runner opened without adding parts.
                1..=3 => {
                    role = Role::User;
                    let mut text = make_tagged(
                        "text",
                        &mut tag,
                        PartBody::Text {
                            text: format!("Review transcript {seed}, turn {ordinal}.").into(),
                        },
                    );
                    if pick.is_multiple_of(2) {
                        text.tokens = Some(PartTokens::count(24));
                    }
                    vec![text]
                }
                4 => vec![make_tagged(
                    "text",
                    &mut tag,
                    PartBody::Text {
                        text: format!("I committed abc1234 and checked the output at {ordinal}.")
                            .into(),
                    },
                )],
                _ => {
                    let name = ["read", "edit", "grep", "ctx_keep"][(pick / 12 % 4) as usize];
                    let status = match pick / 48 % 8 {
                        0 => ToolStatus::Error,
                        1 => ToolStatus::Denied,
                        _ => ToolStatus::Completed,
                    };
                    let path = format!("src/{}.rs", pick / 384 % 3);
                    let call = ToolPart::new(
                        format!("call-{ordinal}"),
                        name,
                        json!({"path": path, "oldString": "a", "newString": "b"}),
                        status,
                    )
                    .with_output_bytes(100 + pick % 16_384);
                    vec![make_tagged("tool", &mut tag, PartBody::Tool(call))]
                }
            };
            Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, parts)
        })
        .collect()
}

#[test]
fn generated_transcripts_match_the_carried_parts_baseline() {
    let mut views = Sha256::new();
    let mut estimates = Sha256::new();
    let mut chunks = Sha256::new();
    let mut changed_views = 0;
    for seed in 0..64 {
        let entries = generated_entries(seed);
        let mut index = Index::default();
        index.extend(entries.iter().cloned());
        let edited = lanes::Edited::default();
        let protected_tools = BTreeMap::from([("read".into(), 2)]);
        let context = lanes::Context {
            index: &index,
            edited: &edited,
            protected_tools: &protected_tools,
            keep_first_message: seed.is_multiple_of(2),
            signed_floor: None,
        };
        let cutoff = lanes::protected_cutoff(&context, 4_000);
        let mark = lanes::far_behind_bookmark(&context, 160_000);
        let notice_mark = lanes::notice_far_behind_bookmark(&context, 160_000);
        let mut choices = lanes::superseded_edits(&context, cutoff, mark);
        choices.extend(lanes::superseded_reads(&context, cutoff));
        choices.extend(lanes::retried_failures(&context, cutoff));
        choices.extend(lanes::age_sweep(&context, mark, notice_mark, cutoff));
        let (ops, _) = lanes::drop_ops(&context, &choices);
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let view = view_builder::next_view(None, &entries, ops, &rules, 1, |_| false).unwrap();
        changed_views += usize::from(view.is_some());
        views.update(serde_json::to_vec(&view).unwrap());

        let weights: Vec<_> = entries
            .iter()
            .flat_map(|entry| &entry.parts)
            .map(|part| (tokens::part(part), tokens::removed_by_summary(part)))
            .collect();
        let nudge = mc_module::nudges::measure(&context, cutoff, &BTreeSet::new());
        estimates.update(format!(
            "{weights:?}{cutoff:?}{mark:?}{notice_mark:?}{nudge:?}\n"
        ));

        let counter = Counter::for_model(None);
        for budget in [120, 1_200, 12_000] {
            for lines in [chunk::Lines::Merged, chunk::Lines::PerMessage] {
                let chunk = chunk::build_with(&entries, budget, lines, counter).unwrap();
                chunks.update(format!("{chunk:?}\n"));
            }
        }
    }
    assert!(changed_views > 32, "corpus must exercise real view edits");
    // These fingerprints pin what views, estimates and chunks produce when
    // the runner sends every part, including transcripts with empty rows.
    assert_eq!(
        format!("{:x}", views.finalize()),
        "2d4ee332d0193e1063ba68db75fde062ca136b5b05d62758f6225335b3015725",
        "serialized views"
    );
    assert_eq!(
        format!("{:x}", estimates.finalize()),
        "adf84561dace25d03650f2119450dec260068f7b6fad82b31f41096bc06a97fd",
        "request estimates and boundaries"
    );
    assert_eq!(
        format!("{:x}", chunks.finalize()),
        "536793814935992bf604eb5c987c2499073b6597e9b1717b1785dd3ab52d1636",
        "historian chunks"
    );
}
