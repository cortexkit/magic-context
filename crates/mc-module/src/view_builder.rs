//! Building the next view. A view is cumulative: it repeats every edit of the
//! previous one that still names a message in the transcript, with that
//! edit's original `since`, and adds the new edits with its own version. A
//! new edit replaces a carried one it supersedes: an inserted message with
//! the same id, and the cut, along with every edit on a message the new cut
//! removes. Then
//! it adds whatever the provider rules require because of the new edits (a
//! signed reasoning part whose history changed must go too), and checks the
//! result with the same functions the runner will use, so ck-mc never
//! publishes a view the runner would refuse.

use cortexkit_role_compaction::read::Entry;
use cortexkit_role_compaction::rules::ProviderRules;
use std::collections::HashSet;

use cortexkit_compaction_view::render::{self as view, edits_for_transcript};
use cortexkit_compaction_view::rules;
use cortexkit_role_compaction::view::{Edit, EditOp, View, ViewRefusal};

/// Positive certificates for inserted payloads. The full planner still checks
/// IDs, anchors, conflicts, cuts and transcript targets on every build; only
/// immutable text/image validation is reused after an exact payload match.
#[derive(Default)]
pub(crate) struct ValidationCache {
    inserts: Vec<EditOp>,
    hash_prefix: Vec<(Edit, sha2::Sha256)>,
    hash_anchor: Option<String>,
    wire_sizes: Vec<(Edit, usize)>,
}

impl ValidationCache {
    pub(crate) fn prime(&mut self, entries: &[Entry], view: &View) {
        self.inserts = view
            .edits
            .iter()
            .filter(|e| matches!(e.op, EditOp::Insert { .. }))
            .filter(|e| view::plan(entries, std::slice::from_ref(e)).is_ok())
            .map(|e| e.op.clone())
            .collect();
        self.seal(
            view.version,
            view.edits.clone(),
            view.built_through.clone(),
            view.new_signed.clone(),
        );
        self.encoded_size(view);
    }

    /// RFC 8785 orders the policy anchor before edits, then the signed policy
    /// and version. Reuse
    /// SHA-256 state only for an exact unchanged leading edit sequence; encode
    /// changed edits and the version through the same pinned JCS serializer.
    /// This produces the contract's checksum without hashing old history again.
    fn seal(
        &mut self,
        version: u64,
        edits: Vec<Edit>,
        built_through: Option<String>,
        new_signed: Option<String>,
    ) -> View {
        use sha2::{Digest, Sha256};
        let _timing = crate::notice_cost_timing::span("view.checksum");
        let mut hash = Sha256::new();
        if self.hash_anchor != built_through {
            self.hash_prefix.clear();
            self.hash_anchor = built_through.clone();
        }
        hash.update(b"{");
        if let Some(anchor) = &built_through {
            hash.update(b"\"built_through\":");
            hash.update(serde_jcs::to_vec(anchor).expect("canonical anchor"));
            hash.update(b",");
        }
        hash.update(b"\"edits\":[");
        let mut unchanged = true;
        let mut prefix = Vec::new();
        for (index, edit) in edits.iter().enumerate() {
            if index > 0 {
                hash.update(b",");
            }
            if unchanged
                && self
                    .hash_prefix
                    .get(index)
                    .is_some_and(|(old, _)| old == edit)
            {
                hash = self.hash_prefix[index].1.clone();
            } else {
                unchanged = false;
                let value = serde_json::to_value(edit).expect("edit value");
                hash.update(serde_jcs::to_vec(&value).expect("canonical edit"));
            }
            // Cache hashes for up to four leading edits to bound memory even
            // for a long cumulative edit list.
            if index < 4 {
                prefix.push((edit.clone(), hash.clone()));
            }
        }
        hash.update(b"]");
        if let Some(policy) = &new_signed {
            hash.update(b",\"new_signed\":");
            hash.update(serde_jcs::to_vec(policy).expect("canonical signed policy"));
        }
        hash.update(b",\"version\":");
        hash.update(serde_jcs::to_vec(&serde_json::json!(version)).expect("canonical version"));
        hash.update(b"}");
        let mut view = View::seal(version, vec![]);
        view.checksum = format!("{:x}", hash.finalize());
        view.edits = edits;
        view.built_through = built_through;
        view.new_signed = new_signed;
        self.hash_prefix = prefix;
        view
    }

    pub(crate) fn encoded_size(&mut self, view: &View) -> usize {
        let mut header =
            serde_json::json!({"version":view.version,"checksum":view.checksum,"edits":[]});
        if let Some(anchor) = &view.built_through {
            header["built_through"] = serde_json::json!(anchor);
        }
        if let Some(policy) = &view.new_signed {
            header["new_signed"] = serde_json::json!(policy);
        }
        let mut size = serde_json::to_vec(&header).expect("view header").len();
        let mut next = Vec::new();
        for (index, edit) in view.edits.iter().enumerate() {
            let bytes = self
                .wire_sizes
                .iter()
                .find(|(old, _)| old == edit)
                .map(|(_, size)| *size)
                .unwrap_or_else(|| serde_json::to_vec(edit).expect("edit bytes").len());
            size = size
                .saturating_add(bytes)
                .saturating_add(usize::from(index > 0));
            if index < 4 {
                next.push((edit.clone(), bytes));
            }
        }
        self.wire_sizes = next;
        size
    }

    fn check(
        &mut self,
        entries: &[Entry],
        candidate: &View,
        rules: &ProviderRules,
    ) -> Result<(), ViewRefusal> {
        let edits = &candidate.edits;
        #[cfg(all(feature = "notice-cost-timing", target_os = "linux"))]
        {
            crate::notice_cost_timing::observe("view.held_entries", entries.len() as u64);
            crate::notice_cost_timing::observe("view.edit_count", edits.len() as u64);
            crate::notice_cost_timing::observe(
                "view.max_text_bytes",
                entries
                    .iter()
                    .flat_map(|e| &e.parts)
                    .filter_map(|p| match &p.body {
                        cortexkit_role_compaction::part::PartBody::Text { text } => {
                            Some(text.len() as u64)
                        }
                        _ => None,
                    })
                    .max()
                    .unwrap_or(0),
            );
        }
        let mut bounded = edits.to_vec();
        for edit in &mut bounded {
            if self.inserts.contains(&edit.op) {
                let _timing = crate::notice_cost_timing::span("view.cached_payload");
                if let EditOp::Insert { message, .. } = &mut edit.op {
                    message.texts.clear();
                    message.images.clear();
                }
            } else if matches!(edit.op, EditOp::Insert { .. }) {
                let _timing = crate::notice_cost_timing::span("view.new_payload");
            }
        }
        let targets: HashSet<&str> = edits
            .iter()
            .filter_map(|e| match &e.op {
                EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => Some(mid.as_str()),
                EditOp::Cut { through } => Some(through.as_str()),
                EditOp::Insert {
                    at: cortexkit_role_compaction::view::InsertAt::Before(mid),
                    ..
                } => Some(mid.as_str()),
                _ => None,
            })
            .collect();
        let cut = edits
            .iter()
            .filter_map(|e| match &e.op {
                EditOp::Cut { through } => entries
                    .iter()
                    .find(|e| &e.mid == through)
                    .map(|e| e.ordinal),
                _ => None,
            })
            .max();
        // Planning renders every untouched part and hashes its cloned body,
        // even though this provider discards the plan. Structural validation
        // only needs named targets/anchors, the entire cut prefix (running
        // calls there veto a cut), and the entry the request ends on: the
        // check that a view never removes the request's final turn looks for
        // the newest entry with parts, so a projection without it would
        // judge some earlier entry to be the end. All edits remain,
        // preserving duplicate-ID and cross-edit checks. Provider signed-part
        // rules need every signed entry and the policy anchor too. A trailing
        // system note also protects the newest non-system turn.
        let final_turn = entries
            .iter()
            .rev()
            .find(|e| !e.parts.is_empty())
            .map(|e| e.ordinal);
        let final_non_system = entries
            .iter()
            .rev()
            .find(|e| {
                !e.parts.is_empty() && e.role != cortexkit_role_compaction::read::Role::System
            })
            .map(|e| e.ordinal);
        let touched: Vec<_> = entries
            .iter()
            .filter(|e| {
                targets.contains(e.mid.as_str())
                    || cut.is_some_and(|cut| e.ordinal <= cut)
                    || Some(e.ordinal) == final_turn
                    || Some(e.ordinal) == final_non_system
                    || candidate.built_through.as_ref() == Some(&e.mid)
                    || e.parts
                        .iter()
                        .any(|part| part.seal == cortexkit_role_compaction::part::Seal::Signed)
            })
            .cloned()
            .collect();
        {
            let _timing = crate::notice_cost_timing::span("view.bounded_plan");
            let bounded = View::seal_with_policy(
                candidate.version,
                bounded,
                candidate.built_through.clone(),
                candidate.new_signed.clone(),
            );
            view::plan_view(&touched, &bounded, rules)?;
        }
        self.inserts = edits
            .iter()
            .filter(|e| matches!(e.op, EditOp::Insert { .. }))
            .map(|e| e.op.clone())
            .collect();
        Ok(())
    }
}

/// The next view, or `None` when it would change nothing: no new edit, and
/// nothing of the previous view left out. Carried edits for which `retire`
/// holds are left out, such as a history head with no summaries left to show.
pub fn next_view(
    previous: Option<&View>,
    entries: &[Entry],
    new_ops: Vec<EditOp>,
    rules: &ProviderRules,
    version: u64,
    retire: impl Fn(&EditOp) -> bool,
) -> Result<Option<View>, ViewRefusal> {
    next_view_cached(
        previous,
        entries,
        new_ops,
        ViewPolicy {
            rules,
            version,
            built_through: entries.last().map(|entry| entry.mid.clone()),
            new_signed: None,
        },
        retire,
        &mut ValidationCache::default(),
    )
}

pub(crate) struct ViewPolicy<'a> {
    pub rules: &'a ProviderRules,
    pub version: u64,
    pub built_through: Option<String>,
    pub new_signed: Option<String>,
}

pub(crate) fn next_view_cached(
    previous: Option<&View>,
    entries: &[Entry],
    new_ops: Vec<EditOp>,
    policy: ViewPolicy<'_>,
    retire: impl Fn(&EditOp) -> bool,
    validation: &mut ValidationCache,
) -> Result<Option<View>, ViewRefusal> {
    let _timing = crate::notice_cost_timing::span("view.next");
    let ViewPolicy {
        rules,
        version,
        built_through,
        new_signed,
    } = policy;
    let previous_edits = previous
        .map(|view| view.edits.as_slice())
        .unwrap_or_default();
    let mut edits = edits_for_transcript(entries, previous_edits);
    let ordinal_of = |mid: &str| {
        entries
            .iter()
            .find(|entry| entry.mid == mid)
            .map(|entry| entry.ordinal)
    };
    let new_cut = new_ops.iter().find_map(|op| match op {
        EditOp::Cut { through } => ordinal_of(through),
        _ => None,
    });
    let new_inserts: HashSet<&str> = new_ops
        .iter()
        .filter_map(|op| match op {
            EditOp::Insert { message, .. } => Some(message.id.as_str()),
            _ => None,
        })
        .collect();
    // A changed inserted message keeps its place among the inserts, so the
    // history head's two messages stay in order (`m[0]` before `m[1]`) when
    // only one of them changes. Appending it instead would move it behind
    // the other and rewrite the whole request.
    let mut replaced_in_place = false;
    for op in &new_ops {
        let EditOp::Insert { message, .. } = op else {
            continue;
        };
        let carried = edits.iter_mut().find(
            |edit| matches!(&edit.op, EditOp::Insert { message: old, .. } if old.id == message.id),
        );
        if let Some(edit) = carried {
            if edit.op != *op {
                *edit = Edit::new(version, op.clone());
                replaced_in_place = true;
            }
        }
    }
    // A part that new edits change loses its earlier edits: a drop of a
    // part an earlier view only trimmed replaces the trimming.
    let newly_edited: HashSet<(&str, &str)> = new_ops
        .iter()
        .filter_map(|op| match op {
            EditOp::Drop {
                mid,
                part: Some(part),
            }
            | EditOp::Replace { mid, part, .. } => Some((mid.as_str(), part.as_str())),
            _ => None,
        })
        .collect();
    let replaced = |edit: &Edit| match &edit.op {
        EditOp::Insert { message, .. } => {
            new_inserts.contains(message.id.as_str()) && !new_ops.contains(&edit.op)
        }
        EditOp::Cut { .. } => new_cut.is_some() && !new_ops.contains(&edit.op),
        EditOp::Drop { mid, part } => {
            new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
                || part.as_deref().is_some_and(|part| {
                    newly_edited.contains(&(mid.as_str(), part)) && !new_ops.contains(&edit.op)
                })
        }
        EditOp::Replace { mid, part, .. } => {
            new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
                || (newly_edited.contains(&(mid.as_str(), part.as_str()))
                    && !new_ops.contains(&edit.op))
        }
        // ck-mc never builds an op the contract doesn't define.
        _ => false,
    };
    edits.retain(|edit| !replaced(edit) && !retire(&edit.op));
    let new_ops: Vec<EditOp> = new_ops
        .into_iter()
        .filter(|op| match op {
            EditOp::Drop { mid, .. } | EditOp::Replace { mid, .. } => {
                !new_cut.is_some_and(|cut| ordinal_of(mid).is_some_and(|ordinal| ordinal <= cut))
            }
            _ => true,
        })
        .collect();
    let dropped_some = edits.len() != previous_edits.len();
    let mut added = false;
    for op in new_ops {
        if edits.iter().any(|edit| edit.op == op) {
            continue;
        }
        edits.push(Edit::new(version, op));
        added = true;
    }
    if !added && !dropped_some && !replaced_in_place {
        return Ok(None);
    }
    loop {
        let invalid = rules::invalid_signed_parts(entries, &edits, rules);
        if invalid.is_empty() {
            break;
        }
        edits.extend(invalid.into_iter().map(|(mid, part)| {
            Edit::new(
                version,
                EditOp::Drop {
                    mid,
                    part: Some(part),
                },
            )
        }));
    }
    let view = validation.seal(version, edits, built_through, new_signed);
    let _timing = crate::notice_cost_timing::span("view.check");
    {
        let _timing = crate::notice_cost_timing::span("view.check_carried");
        view::check_carried(previous, &view)?;
    }
    {
        let _timing = crate::notice_cost_timing::span("view.plan");
        // The view was sealed immediately above. Planning performs every edit
        // and transcript check that apply performs, without constructing and
        // hashing rendered message parts that this provider would discard.
        validation.check(entries, &view, rules)?;
    }
    Ok(Some(view))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::part::{Part, PartBody, Seal};
    use cortexkit_role_compaction::read::Role;
    use cortexkit_role_compaction::rules::{EditCost, SignedParts};
    use serde_json::json;

    #[test]
    fn cached_sealing_and_size_match_contract_bytes_on_every_change() {
        let mut cache = ValidationCache::default();
        for version in [1, 2, 10, 9_007_199_254_740_993, u64::MAX] {
            for suffix in ["same", "changed", "same"] {
                let mut edits = vec![
                    Edit::new(
                        1,
                        insert("m0", &"history \"\\\n 雪 §quoted§ ".repeat(12_000)),
                    ),
                    Edit::new(1, insert("m1", "delta")),
                ];
                edits.push(Edit::new(version,EditOp::Replace {mid:"target".into(),part:"part".into(),field:"input.options".into(),value:json!({"z":1e21,"a":-0.0,"fraction":1.25,"unicode":"\u{1f600}","suffix":suffix}),expect:"digest".into()}));
                let reference = View::seal(version, edits.clone());
                let next = cache.seal(version, edits, None, None);
                assert_eq!(
                    serde_json::to_vec(&next).unwrap(),
                    serde_json::to_vec(&reference).unwrap()
                );
                assert_eq!(
                    cache.encoded_size(&next),
                    serde_json::to_vec(&reference).unwrap().len()
                );
            }
        }
    }

    #[test]
    fn contract_update_cached_policy_checksum_matches_contract() {
        let mut cache = ValidationCache::default();
        for anchor in [None, Some("m2"), Some("m2"), Some("new-branch"), None] {
            for strip in [None, Some("strip"), None] {
                let edits = vec![Edit::new(1, insert("head", "history"))];
                let expected = View::seal_with_policy(
                    3,
                    edits.clone(),
                    anchor.map(str::to_owned),
                    strip.map(str::to_owned),
                );
                let actual = cache.seal(
                    3,
                    edits,
                    anchor.map(str::to_owned),
                    strip.map(str::to_owned),
                );
                assert_eq!(actual, expected);
                assert_eq!(
                    cache.encoded_size(&actual),
                    serde_json::to_vec(&expected).unwrap().len()
                );
            }
        }
    }

    fn insert(id: &str, text: &str) -> EditOp {
        EditOp::Insert {
            at: cortexkit_role_compaction::view::InsertAt::Start,
            message: cortexkit_role_compaction::view::InsertedMessage::new(
                id,
                Role::User,
                vec![text.into()],
            ),
        }
    }

    fn insert_ids(view: &View) -> Vec<String> {
        view.edits
            .iter()
            .filter_map(|edit| match &edit.op {
                EditOp::Insert { message, .. } => Some(message.id.clone()),
                _ => None,
            })
            .collect()
    }

    /// When only the first of two inserted messages changes, it keeps its
    /// place: the history head stays `m[0]` then `m[1]`.
    #[test]
    fn a_changed_insert_keeps_its_place_among_the_inserts() {
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let first = next_view(
            None,
            &[],
            vec![insert("m0", "baseline"), insert("m1", "nothing new")],
            &rules,
            1,
            |_| false,
        )
        .unwrap()
        .unwrap();
        let second = next_view(
            Some(&first),
            &[],
            vec![
                insert("m0", "baseline, folded"),
                insert("m1", "nothing new"),
            ],
            &rules,
            2,
            |_| false,
        )
        .unwrap()
        .expect("a changed m[0] is a new view");
        assert_eq!(insert_ids(&second), ["m0", "m1"]);
        assert_eq!(second.edits[0].since, 2);
        assert_eq!(second.edits[1].since, 1);
    }

    /// ck-mc checks a view with the runner's own functions before it
    /// publishes, so a lane that asks for an edit the contract forbids gets a
    /// refusal here, not a view the runner would refuse.
    #[test]
    fn a_view_the_runner_would_refuse_is_never_built() {
        let reasoning = Part::new(
            "r1",
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(40),
            },
        )
        .with_seal(Seal::Encrypted);
        let entry = Entry::new(1, "m1", Role::Assistant, 0, vec![reasoning.clone()]);
        // A later message, so dropping m1's only part leaves the request a
        // turn to end on.
        let later = Entry::new(
            2,
            "m2",
            Role::User,
            0,
            vec![Part::new(
                "t",
                PartBody::Text {
                    text: "next".into(),
                },
            )],
        );
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        // A sealed part can be dropped but never replaced.
        let replace = EditOp::Replace {
            mid: "m1".into(),
            part: "r1".into(),
            field: "text".into(),
            value: json!("shorter"),
            expect: reasoning.digest.clone(),
        };
        assert!(next_view(
            None,
            std::slice::from_ref(&entry),
            vec![replace],
            &rules,
            1,
            |_| false
        )
        .is_err());
        let drop = EditOp::Drop {
            mid: "m1".into(),
            part: Some("r1".into()),
        };
        assert!(matches!(
            next_view(None, &[entry, later], vec![drop], &rules, 1, |_| false),
            Ok(Some(_))
        ));
    }

    fn text_entry(ordinal: u64, role: Role) -> Entry {
        Entry::new(
            ordinal,
            format!("m{ordinal}"),
            role,
            0,
            vec![Part::new(
                "t",
                PartBody::Text {
                    text: format!("message {ordinal}"),
                },
            )],
        )
    }

    /// The view check plans only the entries a view names, the cut prefix,
    /// and the entry the request ends on. Without that last one, a cut far
    /// from the end looked like a cut through the final turn, and every
    /// history view was refused.
    #[test]
    fn the_bounded_check_judges_the_final_turn_by_the_whole_transcript() {
        let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
        let mut entries: Vec<Entry> = (1..=6)
            .map(|n| {
                text_entry(
                    n,
                    if n % 2 == 1 {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                )
            })
            .collect();
        // A message with no parts after the end, as a step the runner has
        // opened but not filled.
        entries.push(Entry::new(7, "m7", Role::Assistant, 0, vec![]));
        let cut = |through: &str| EditOp::Cut {
            through: through.into(),
        };
        let mut cache = ValidationCache::default();
        let early = next_view_cached(
            None,
            &entries,
            vec![cut("m2")],
            ViewPolicy {
                rules: &rules,
                version: 1,
                built_through: entries.last().map(|e| e.mid.clone()),
                new_signed: None,
            },
            |_| false,
            &mut cache,
        );
        assert!(matches!(early, Ok(Some(_))), "{early:?}");
        // A cut through the newest message with parts is still refused, even
        // with the empty message after it.
        let through_end = next_view_cached(
            None,
            &entries,
            vec![cut("m6")],
            ViewPolicy {
                rules: &rules,
                version: 1,
                built_through: entries.last().map(|e| e.mid.clone()),
                new_signed: None,
            },
            |_| false,
            &mut cache,
        );
        assert!(
            matches!(
                through_end,
                Err(ViewRefusal::Rule(
                    cortexkit_role_compaction::rules::RuleBreak::FinalTurnRemoved { .. }
                ))
            ),
            "{through_end:?}"
        );
    }
    #[test]
    fn cached_insert_checks_match_full_apply_on_valid_and_invalid_views() {
        use cortexkit_role_compaction::read::Role;
        use cortexkit_role_compaction::view::{InsertAt, InsertedMessage};
        let mut entries = vec![Entry::new(1, "m1", Role::User, 0, vec![])];
        entries.push(Entry::new(
            2,
            "m2",
            Role::Assistant,
            0,
            vec![Part::new(
                "p2",
                PartBody::Tool(cortexkit_role_compaction::part::ToolPart::new(
                    "call",
                    "read",
                    json!({"path":"a.rs"}),
                    cortexkit_role_compaction::part::ToolStatus::Running,
                )),
            )],
        ));
        entries.push(Entry::new(
            3,
            "m3",
            Role::User,
            0,
            vec![Part::new(
                "p3",
                PartBody::Text {
                    text: "original reference §9§".into(),
                },
            )
            .with_tag(3)],
        ));
        let head = Edit::new(
            1,
            EditOp::Insert {
                at: InsertAt::Start,
                message: InsertedMessage::new(
                    "m0",
                    Role::User,
                    vec!["unchanged history ".repeat(12_000)],
                ),
            },
        );
        let before = View::seal(1, vec![head.clone()]);
        let mut cache = ValidationCache::default();
        cache.prime(&entries, &before);
        let mut cases = vec![vec![head.clone()], vec![head.clone(), head.clone()]];
        for (at, text, role) in [
            (InsertAt::Start, "a new valid head", Role::User),
            (InsertAt::Start, "invalid §99§ inserted tag", Role::User),
            (
                InsertAt::Before("missing".into()),
                "unknown anchor",
                Role::User,
            ),
            (
                InsertAt::Start,
                "unknown role",
                Role::Unknown("new-role".into()),
            ),
        ] {
            cases.push(vec![
                head.clone(),
                Edit::new(
                    2,
                    EditOp::Insert {
                        at,
                        message: InsertedMessage::new("delta", role, vec![text.into()]),
                    },
                ),
            ]);
        }
        cases.push(vec![
            head,
            Edit::new(
                2,
                EditOp::Drop {
                    mid: "missing".into(),
                    part: None,
                },
            ),
        ]);
        for op in [
            EditOp::Cut {
                through: "m1".into(),
            },
            EditOp::Cut {
                through: "m2".into(),
            },
            EditOp::Drop {
                mid: "m2".into(),
                part: Some("p2".into()),
            },
            EditOp::Replace {
                mid: "m3".into(),
                part: "p3".into(),
                field: "text".into(),
                value: json!("own §3§ and original §9§"),
                expect: entries[2].parts[0].digest.clone(),
            },
            EditOp::Replace {
                mid: "m3".into(),
                part: "p3".into(),
                field: "text".into(),
                value: json!("foreign §7§"),
                expect: entries[2].parts[0].digest.clone(),
            },
        ] {
            cases.push(vec![Edit::new(2, op)]);
        }
        for edits in cases {
            let view = View::seal(2, edits);
            assert_eq!(
                cache.check(
                    &entries,
                    &view,
                    &ProviderRules::new(SignedParts::None, EditCost::Suffix)
                ),
                view::apply(&entries, &view).map(|_| ())
            );
        }
    }
}
