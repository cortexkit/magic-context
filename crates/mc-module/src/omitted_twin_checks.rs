//! Transcript pairs and the request-side measurements that must agree when
//! a runner retains a stored part but never sends it to a model.

use super::*;
use crate::lanes;
use crate::summary::{chunk, trigger};
use cortexkit_role_compaction::part::{
    Attachment, AttachmentItem, FileMedia, Part, PartBody, Seal, ToolPart, ToolStatus,
};
use cortexkit_role_compaction::read::{Entry, HostFrame, HostPart, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::tokens::PartTokens;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

const OMIT: &str = "omit-";

#[derive(Clone, Debug)]
pub(crate) struct Slot {
    pub role: Role,
    pub parts: Vec<(Part, bool)>,
    /// A notice from the runner: `Some(keep)`.
    pub notice: Option<bool>,
}

pub(crate) struct Rng(pub u64);
impl Rng {
    pub fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    pub fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

fn text_part(id: String, text: String) -> Part {
    Part::new(id, PartBody::Text { text: text.into() })
}

fn tool_part(rng: &mut Rng, id: String, n: usize, running_ok: bool) -> Part {
    let names = [
        "read",
        "edit",
        "write",
        "grep",
        "bash",
        "ctx_keep",
        "todowrite",
        "read",
        "edit",
    ];
    let name = names[rng.below(names.len() as u64) as usize];
    let path = ["src/a.rs", "src/b.rs", "src/c.rs"][rng.below(3) as usize];
    let input = match name {
        "edit" => json!({"path": path, "oldString": "a", "newString": "b"}),
        "write" => json!({"path": path, "content": "x"}),
        "read" => json!({"path": path}),
        "grep" => json!({"pattern": "fn", "path": path}),
        "bash" => json!({"command": "cargo test"}),
        "ctx_keep" => json!({"keep": "1"}),
        _ => json!({"todos": []}),
    };
    let status = match rng.below(100) {
        0..=69 => ToolStatus::Completed,
        70..=81 => ToolStatus::Error,
        82..=93 => ToolStatus::Denied,
        _ if running_ok => ToolStatus::Running,
        _ => ToolStatus::Completed,
    };
    let output = match rng.below(10) {
        0 => 0,
        1..=6 => 100 + rng.below(6_000),
        _ => 6_000 + rng.below(40_000),
    };
    let mut tool =
        ToolPart::new(format!("call-{n}"), name, input, status).with_output_bytes(output);
    if rng.chance(12) {
        tool.set_attachments(vec![Attachment::new(
            "image",
            AttachmentItem::File(FileMedia::inline("image/png", Some(500))),
        )]);
    }
    let mut part = Part::new(id, PartBody::Tool(tool));
    if rng.chance(30) {
        part.tokens = Some(PartTokens::tool(20 + rng.below(40), output / 4));
    }
    part
}

/// A random transcript. `omit_pct` is the chance each part is left out of the
/// request; `slot_omit_pct` the chance a whole non-empty entry is.
pub(crate) fn generate(seed: u64, len: usize, omit_pct: u64, slot_omit_pct: u64) -> Vec<Slot> {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xC0FFEE);
    let mut slots = Vec::new();
    for n in 0..len {
        let roll = rng.below(100);
        let (role, mut parts): (Role, Vec<Part>) = if roll < 8 {
            let role = if rng.chance(50) {
                Role::User
            } else {
                Role::Assistant
            };
            (role, Vec::new())
        } else if roll < 38 {
            let mut parts = Vec::new();
            let text = match rng.below(10) {
                0 => "   ".to_owned(),
                1 => format!("Look at commit deadbee{n} again."),
                _ => format!("Please fix src/a.rs in turn {n} and run the tests."),
            };
            let mut t = text_part("p0".into(), text);
            if rng.chance(40) {
                t.tokens = Some(PartTokens::count(10 + rng.below(30)));
            }
            parts.push(t);
            if rng.chance(15) {
                parts.push(Part::new(
                    "p1",
                    PartBody::File(FileMedia::inline("image/png", Some(300 + rng.below(3000)))),
                ));
            }
            if rng.chance(10) {
                parts.push(text_part("p2".into(), format!("And also note {n}.")));
            }
            (Role::User, parts)
        } else {
            let count = 1 + rng.below(4) as usize;
            let mut parts = Vec::new();
            for k in 0..count {
                let id = format!("p{k}");
                let part = match rng.below(10) {
                    0..=2 => {
                        let text = match rng.below(12) {
                            0 => "sent".to_owned(),
                            1..=3 => format!("I committed abc{n:04x}def and checked the output."),
                            4 => "long words ".repeat(400 + rng.below(400) as usize),
                            _ => format!("Working on step {n}.{k}: reading the code."),
                        };
                        text_part(id, text)
                    }
                    3..=4 => {
                        let seal = if rng.chance(35) {
                            Seal::Signed
                        } else {
                            Seal::None
                        };
                        let bytes = rng.below(9_000);
                        Part::new(
                            id,
                            PartBody::Reasoning {
                                text: None,
                                text_bytes: Some(bytes),
                            },
                        )
                        .with_seal(seal)
                    }
                    _ => tool_part(&mut rng, id, n * 10 + k, true),
                };
                parts.push(part);
            }
            (Role::Assistant, parts)
        };
        let whole = !parts.is_empty() && rng.chance(slot_omit_pct);
        let marked: Vec<(Part, bool)> = parts
            .drain(..)
            .map(|part| {
                let omit = whole || rng.chance(omit_pct);
                (part, omit)
            })
            .collect();
        let notice = (role == Role::User && rng.chance(15)).then(|| rng.chance(40));
        slots.push(Slot {
            role,
            parts: marked,
            notice,
        });
    }
    slots
}

fn numbered(role: &Role, body: &PartBody) -> bool {
    *role != Role::System
        && match body {
            PartBody::Text { .. } => true,
            PartBody::Tool(tool) => !tool.provider_executed,
            _ => false,
        }
}

/// The marked transcript, its
/// twin with those parts deleted and renumbered (for the index), and its twin
/// with the same ordinals and gaps (for slice readers).
pub(crate) fn materialize(
    slots: &[Slot],
    tag_omitted: bool,
) -> (Vec<Entry>, Vec<Entry>, Vec<Entry>) {
    let mut tag = 0;
    let mut marked = Vec::new();
    let mut renum = Vec::new();
    let mut gap = Vec::new();
    for (i, slot) in slots.iter().enumerate() {
        let ordinal = i as u64 + 1;
        let mid = format!("m{ordinal}");
        let mut mparts = Vec::new();
        let mut tparts = Vec::new();
        for (part, omit) in &slot.parts {
            let mut part = part.clone();
            part.tag = None;
            if numbered(&slot.role, &part.body) && (!omit || tag_omitted) {
                tag += 1;
                part.tag = Some(tag);
            }
            if *omit {
                part.omitted = true;
                part.tokens = None;
                part.id = format!("{OMIT}{}", part.id);
                mparts.push(part);
            } else {
                mparts.push(part.clone());
                tparts.push(part);
            }
        }
        let absent = !slot.parts.is_empty() && tparts.is_empty();
        let decorate = |entry: Entry| {
            let entry = match slot.notice {
                Some(keep) => entry.with_notice(
                    cortexkit_role_compaction::read::NoticeOrigin::new("core").with_keep(keep),
                ),
                None => entry,
            };
            host_metadata(entry)
        };
        marked.push(decorate(Entry::new(
            ordinal,
            mid.clone(),
            slot.role.clone(),
            ordinal,
            mparts,
        )));
        if !absent {
            gap.push(decorate(Entry::new(
                ordinal,
                mid.clone(),
                slot.role.clone(),
                ordinal,
                tparts.clone(),
            )));
            renum.push(decorate(Entry::new(
                renum.len() as u64 + 1,
                mid.clone(),
                slot.role.clone(),
                ordinal,
                tparts,
            )));
        }
    }
    (marked, renum, gap)
}

pub(crate) fn framed_text(words: &str) -> Part {
    use cortexkit_role_llm_runner::attribution::host_frames::{
        CLAUDE_CODE_MID_TURN_HEAD as HEAD, CLAUDE_CODE_MID_TURN_TAIL as TAIL,
    };
    text_part("host-frame".into(), format!("{HEAD}{words}{TAIL}"))
}

fn host_metadata(mut entry: Entry) -> Entry {
    use cortexkit_role_llm_runner::attribution::host_frames::{
        CLAUDE_CODE_MID_TURN, CLAUDE_CODE_MID_TURN_HEAD as HEAD, CLAUDE_CODE_MID_TURN_TAIL as TAIL,
    };
    for part in &entry.parts {
        if part.id.ends_with("host-bookkeeping") {
            entry.host_parts.push(HostPart::new(&part.id));
        }
    }
    if let Some(id) = entry
        .parts
        .iter()
        .find(|part| part.id.ends_with("host-frame"))
        .map(|part| part.id.clone())
    {
        entry = entry
            .with_host_frame(
                HostFrame::new(
                    id,
                    CLAUDE_CODE_MID_TURN,
                    HEAD.len() as u32,
                    TAIL.len() as u32,
                ),
                true,
            )
            .unwrap();
    }
    entry
}

pub(crate) type Checks = Vec<(String, String)>;

fn mids(keys: impl IntoIterator<Item = String>) -> String {
    format!("{:?}", keys.into_iter().collect::<Vec<_>>())
}

/// Request-side outputs that take the index. Values are mid/part-id based, so
/// the renumbered twin compares equal.
pub(crate) fn index_checks(entries: &[Entry], keep_first: bool) -> Checks {
    let mut out: Checks = Vec::new();
    let mut put = |name: String, value: String| out.push((name, value));
    let mut index = crate::index::Index::default();
    index.extend(entries.iter().cloned());
    let edited = lanes::Edited::default();
    let protected_tools: BTreeMap<String, u64> =
        BTreeMap::from([("read".into(), 2), ("edit".into(), 1)]);
    let ctx = lanes::Context {
        index: &index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: keep_first,
        // Compare the same logical floor even if its stored row was removed
        // in the twin. Message ids still name the original positions.
        signed_floor: keep_first
            .then(|| {
                entries
                    .iter()
                    .rfind(|entry| {
                        entry.mid[1..].parse::<u64>().unwrap() <= 3
                            && (entry.parts.is_empty()
                                || entry.parts.iter().any(|part| !part.omitted))
                    })
                    .map(|entry| entry.ordinal)
            })
            .flatten(),
    };
    let all = || entries.iter().flat_map(|e| e.parts.iter());
    put(
        "tokens.part_sum".into(),
        all().map(crate::tokens::part).sum::<u64>().to_string(),
    );
    put(
        "tokens.removed_sum".into(),
        all()
            .map(crate::tokens::removed_by_summary)
            .sum::<u64>()
            .to_string(),
    );
    put(
        "tokens.tool_result_output_sum".into(),
        all()
            .filter_map(|p| match &p.body {
                PartBody::Tool(t) => {
                    Some(crate::tokens::tool_result(p, t) + 7 * crate::tokens::tool_output(p, t))
                }
                _ => None,
            })
            .sum::<u64>()
            .to_string(),
    );
    for floor in [0u64, 500, 4_000, 40_000] {
        put(
            format!("protected_cutoff.{floor}"),
            format!("{:?}", lanes::protected_cutoff(&ctx, floor)),
        );
    }
    for w in [2_000u64, 8_000, 160_000] {
        put(
            format!("far_behind.{w}"),
            lanes::far_behind_bookmark(&ctx, w).to_string(),
        );
        put(
            format!("notice_far_behind.{w}"),
            lanes::notice_far_behind_bookmark(&ctx, w).to_string(),
        );
    }
    let cutoff = lanes::protected_cutoff(&ctx, 500);
    let mark = lanes::far_behind_bookmark(&ctx, 8_000);
    let notice_mark = lanes::notice_far_behind_bookmark(&ctx, 8_000);
    let mut choices = Vec::new();
    for (label, cut) in [("cut", cutoff), ("nocut", None)] {
        let lanes_out = [
            ("superseded_edits", lanes::superseded_edits(&ctx, cut, mark)),
            (
                "superseded_edits_all",
                lanes::superseded_edits(&ctx, cut, u64::MAX),
            ),
            ("superseded_reads", lanes::superseded_reads(&ctx, cut)),
            ("retried_failures", lanes::retried_failures(&ctx, cut)),
            ("duplicate_lookups", lanes::duplicate_lookups(&ctx, cut)),
            ("spent_control_plane", lanes::spent_control_plane(&ctx, cut)),
            ("injected_text", lanes::injected_text(&ctx, cut)),
            ("age_sweep", lanes::age_sweep(&ctx, mark, notice_mark, cut)),
            (
                "age_sweep_all",
                lanes::age_sweep(&ctx, u64::MAX, u64::MAX, cut),
            ),
            ("keep_drops", lanes::keep_drops(&ctx, &BTreeSet::new(), cut)),
        ];
        for (name, value) in lanes_out {
            if label == "cut" {
                choices.extend(value.iter().cloned());
            }
            put(format!("lane.{name}.{label}"), format!("{value:?}"));
        }
        let caveman = lanes::caveman(
            &ctx,
            &crate::pass::Caveman {
                min_chars: 10,
                english_word_rules: true,
            },
            &lanes::CavemanState::default(),
            cut,
            &[],
        );
        put(format!("lane.caveman.{label}"), format!("{:?}", caveman.0));
    }
    for budget in [0u64, 300, 3_000, 30_000] {
        for anthropic in [false, true] {
            let value = lanes::reasoning_over_budget(&ctx, budget, anthropic);
            if budget == 3_000 && anthropic {
                choices.extend(value.iter().cloned());
            }
            put(
                format!("lane.reasoning.{budget}.{anthropic}"),
                format!("{value:?}"),
            );
        }
    }
    for over_limit in [false, true] {
        for prompt in [40_000u64, 95_000, 300_000] {
            let emergency = lanes::Emergency {
                prompt_tokens: prompt,
                request_tokens: None,
                notes: Default::default(),
                ceiling_tokens: 65_000,
                usable_tokens: 100_000,
                over_limit,
                priced: false,
                removed_tokens: 0,
            };
            let value = lanes::emergency_drop(&ctx, cutoff, &emergency, &BTreeSet::new());
            put(
                format!("lane.emergency.{over_limit}.{prompt}"),
                format!("{value:?}"),
            );
        }
    }
    put(
        "lane.image_results".into(),
        format!("{:?}", lanes::image_results(&index, &edited)),
    );
    let lookup_through = all().filter_map(|p| p.tag).max().unwrap_or(0);
    let max_tag = all()
        .filter(|p| !p.omitted)
        .filter_map(|p| p.tag)
        .max()
        .unwrap_or(0);
    for watermark in [max_tag / 2, max_tag] {
        let images = lanes::Images {
            outputs: &BTreeMap::new(),
            watermark,
            cutoff,
            over_limit: false,
            skip: &[],
        };
        put(
            format!("lane.answered_images.{}", watermark == max_tag),
            format!("{:?}", lanes::answered_images(&ctx, &images)),
        );
    }
    put(
        "protected_tool_parts".into(),
        format!(
            "{:?}",
            lanes::protected_tool_parts(&index, &protected_tools)
        ),
    );
    put(
        "newest_tool_tags".into(),
        format!("{:?}", index.newest_tool_tags(20)),
    );
    put(
        "starts_user_turn".into(),
        mids(
            entries
                .iter()
                .filter(|e| lanes::starts_user_turn(e))
                .map(|e| e.mid.clone()),
        ),
    );
    put(
        "current_turn_start".into(),
        // The turn starts after this user entry; name the entry itself, since
        // the position after it may be an omitted-only entry in one twin.
        format!(
            "{:?}",
            crate::pass::current_turn_start(entries)
                .map(|i| entries.get(i - 1).map(|e| e.mid.clone()))
        ),
    );
    put(
        "step_reasoning_tokens".into(),
        format!(
            "{:?}",
            entries
                .iter()
                .map(|e| (e.mid.clone(), lanes::step_reasoning_tokens(e)))
                .filter(|(_, n)| *n > 0)
                .collect::<Vec<_>>()
        ),
    );
    put(
        "keep_call".into(),
        format!("{:?}", lanes::keep_call(&index).map(|e| e.mid.clone())),
    );
    for signed in [SignedParts::None, SignedParts::Bound] {
        let mut conditions = fixture().0.conditions.clone();
        conditions.rules = ProviderRules::new(signed.clone(), EditCost::Suffix);
        put(
            format!("heavy_signed_turn.{signed:?}"),
            crate::pass::heavy_signed_turn(entries, &conditions, None).to_string(),
        );
        let covered: Vec<_> = entries
            .iter()
            .flat_map(|entry| {
                entry
                    .parts
                    .iter()
                    .filter(|part| {
                        !part.omitted && part.seal == Seal::Signed && part.id.ends_with('0')
                    })
                    .map(|part| (entry.mid.clone(), part.id.clone()))
            })
            .collect();
        let edited = edited.including(&covered);
        put(
            format!("heavy_signed_turn.edited.{signed:?}"),
            crate::pass::heavy_signed_turn_in_view(
                entries,
                &conditions,
                ctx.signed_floor,
                Some(&edited),
            )
            .to_string(),
        );
    }
    put(
        "find_tag".into(),
        format!(
            "{:?}",
            (1..=lookup_through)
                .filter_map(|tag| index.find_tag(tag).map(|(e, p)| (
                    tag,
                    e.mid.clone(),
                    p.id.clone()
                )))
                .collect::<Vec<_>>()
        ),
    );
    // Every stored part requested, as a queued `ctx_reduce` or an old view
    // would name it: parts the request never carries must not get an edit.
    for (label, shape) in [
        ("requested", lanes::Shape::Requested),
        ("default", lanes::Shape::Default),
        ("whole", lanes::Shape::Whole),
    ] {
        let every: Vec<_> = entries
            .iter()
            .flat_map(|e| {
                e.parts
                    .iter()
                    .map(move |p| ((e.mid.clone(), p.id.clone()), shape))
            })
            .collect();
        let (ops, covered) = lanes::drop_ops(&ctx, &every);
        put(format!("drop_ops.every.{label}.ops"), format!("{ops:?}"));
        put(
            format!("drop_ops.every.{label}.covered"),
            format!("{covered:?}"),
        );
    }
    let (ops, covered) = lanes::drop_ops(&ctx, &choices);
    put("drop_ops.ops".into(), format!("{ops:?}"));
    put("drop_ops.covered".into(), format!("{covered:?}"));
    put(
        "nudges.measure".into(),
        format!(
            "{:?}",
            crate::nudges::measure(&ctx, cutoff, &BTreeSet::new())
        ),
    );
    for signed in [SignedParts::None, SignedParts::Bound] {
        let rules = ProviderRules::new(signed.clone(), EditCost::Suffix);
        let view = crate::view_builder::next_view(None, entries, ops.clone(), &rules, 1, |_| false);
        let value = match view {
            Ok(Some(view)) => serde_json::to_string(&view.edits).unwrap(),
            Ok(None) => "none".into(),
            Err(error) => format!("refused {error:?}"),
        };
        put(format!("view.{signed:?}"), value);
    }
    out
}

/// Request-side outputs that read a slice by ordinal. The twin keeps the same
/// ordinals with gaps where absent entries were. Ordinals a reader returns are
/// compared as the first carried entry at or after them; with `shift_from`
/// (the twin), a start ordinal that names a deleted entry starts at the next
/// entry instead, as a contiguous index would.
pub(crate) fn slice_checks(entries: &[Entry]) -> Checks {
    slice_checks_with(entries, false)
}

pub(crate) fn slice_checks_with(entries: &[Entry], shift_from: bool) -> Checks {
    let mut out: Checks = Vec::new();
    let mut put = |name: String, value: String| out.push((name, value));
    let counter = crate::count::Counter::for_model(None);
    if entries.is_empty() {
        return out;
    }
    let present: Vec<u64> = entries
        .iter()
        .filter(|e| e.parts.is_empty() || e.parts.iter().any(|p| !p.omitted))
        .map(|e| e.ordinal)
        .collect();
    let canon = |u: u64| -> String {
        present
            .iter()
            .find(|o| **o >= u)
            .map_or_else(|| "end".to_owned(), |o| o.to_string())
    };
    let call_from = |from: u64| -> u64 {
        if shift_from {
            present.iter().copied().find(|o| *o >= from).unwrap_or(from)
        } else {
            from
        }
    };
    for budget in [60u64, 400, 4_000, 400_000] {
        for (label, mode) in [
            ("merged", chunk::Lines::Merged),
            ("per", chunk::Lines::PerMessage),
        ] {
            put(
                format!("chunk.{label}.{budget}"),
                format!("{:?}", chunk::build_with(entries, budget, mode, counter)),
            );
        }
    }
    for budget in [40u64, 400, 40_000] {
        put(
            format!("newest.{budget}"),
            format!("{:?}", chunk::newest(entries, budget, counter)),
        );
    }
    put(
        "hashes".into(),
        format!(
            "{:?}",
            crate::summary::hashes::by_ordinal(entries)
                .into_iter()
                .filter(|(_, set)| !set.is_empty())
                .collect::<Vec<_>>()
        ),
    );
    put(
        "meaningful_user".into(),
        format!(
            "{:?}",
            entries
                .iter()
                .filter(|e| trigger::is_meaningful_user(e))
                .map(|e| e.ordinal)
                .collect::<Vec<_>>()
        ),
    );
    // The newest entry the request carries (an omitted-only one is skipped by
    // its id marker, so the marked transcript and its twin pick the same).
    let last = entries
        .iter()
        .rev()
        .find(|e| e.parts.is_empty() || e.parts.iter().any(|p| !p.omitted))
        .map_or(1, |e| e.ordinal);
    let froms = [1u64, (last / 3).max(1), (last / 2).max(1)];
    for label_from in froms {
        let from = call_from(label_from);
        for tail in [0u64, 200, 2_000, 20_000, 70_000] {
            for force in [false, true] {
                let until =
                    trigger::tail_start(entries, super::super::entry_tokens, from, tail, force);
                put(
                    format!("tail_start.{label_from}.{tail}.{force}"),
                    canon(until),
                );
                for cap in [0u64, 150, 3_000, 1_000_000] {
                    put(
                        format!("cap_run.{label_from}.{tail}.{force}.{cap}"),
                        canon(trigger::cap_run(
                            entries,
                            super::super::entry_removed_tokens,
                            from,
                            until,
                            cap,
                        )),
                    );
                }
            }
        }
    }
    // The cached window, fresh and after an incremental sync.
    for incremental in [false, true] {
        for label_from in froms {
            let from = call_from(label_from);
            let mut window = crate::summary::due::Window::default();
            let mut counts = chunk::CountCache::default();
            if incremental && entries.len() > 2 {
                let half = entries.len() / 2;
                window.sync(
                    &entries[..half],
                    1,
                    Some(entries[0].ordinal),
                    from,
                    counter,
                    &mut counts,
                );
                let _ = window.bounded(&entries[..half], from, 200, true, 1_000_000);
                window.sync(
                    entries,
                    1,
                    Some(entries[half].ordinal),
                    from,
                    counter,
                    &mut counts,
                );
            } else {
                window.sync(
                    entries,
                    1,
                    Some(entries[0].ordinal),
                    from,
                    counter,
                    &mut counts,
                );
            }
            put(
                format!("window.prompt.{incremental}.{label_from}"),
                format!("{:?}", window.prompt(entries).map(|e| e.ordinal)),
            );
            for tail in [0u64, 200, 2_000, 20_000] {
                for lift in [false, true] {
                    for cap in [150u64, 1_000_000] {
                        let until = window.bounded(entries, from, tail, lift, cap);
                        put(
                            format!(
                                "window.bounded.{incremental}.{label_from}.{tail}.{lift}.{cap}"
                            ),
                            canon(until),
                        );
                        for budget in [100u64, 4_000] {
                            put(
                                format!("window.scan.{incremental}.{label_from}.{tail}.{lift}.{cap}.{budget}"),
                                format!("{:?}", window.scan(entries, from, until, budget, counter, &mut counts)),
                            );
                        }
                    }
                }
            }
        }
    }
    out
}

fn mid_of(entries: &[Entry], ordinal: u64) -> String {
    entries
        .iter()
        .find(|e| e.ordinal == ordinal)
        .map_or_else(|| format!("#{ordinal}?"), |e| e.mid.clone())
}

/// Session-level request outputs, ordinals mapped to message ids.
pub(crate) fn session_checks(entries: &[Entry], summary_ends: &[String]) -> Checks {
    let mut out: Checks = Vec::new();
    let mut put = |name: String, value: String| out.push((name, value));
    if entries.is_empty() {
        return out;
    }
    let (mut session, _client, _, _, mut settings) = fixture();
    settings.memory_enabled = false;
    session.index.extend(entries.to_vec());
    session.index_ready = true;
    put(
        "served_costs".into(),
        format!("{:?}", session.served_costs(std::iter::empty())),
    );
    for budget in [50u64, 500, 50_000] {
        let value = match session.recent(budget) {
            Ok(value) => format!(
                "{} {} {}",
                value["from_message"]
                    .as_u64()
                    .map_or("-".into(), |o| mid_of(entries, o)),
                value["through_message"]
                    .as_u64()
                    .map_or("-".into(), |o| mid_of(entries, o)),
                value["tokens"], // Equal-ordinal chunk checks compare the actual text.
            ),
            Err(error) => format!("err {error:?}"),
        };
        put(format!("recent.{budget}"), value);
    }
    let empty = BTreeMap::new();
    let visible = session
        .search_scope(&settings, &empty)
        .visible_messages
        .map(|set| {
            set.into_iter()
                .map(|o| mid_of(entries, o as u64))
                .collect::<Vec<_>>()
        });
    put("search.visible".into(), format!("{visible:?}"));
    session.conditions.last_prompt_tokens = Some(95_000);
    session.conditions.output_reserve = 0;
    let built = session.build(&settings, None, false, None).0;
    put(
        "session.build".into(),
        built.map_or("none".into(), |view| {
            serde_json::to_string(&view.edits).unwrap()
        }),
    );
    for end in summary_ends {
        let Some(end_entry) = entries.iter().find(|e| &e.mid == end) else {
            continue;
        };
        let (mut session, _client, _, _, mut settings) = fixture();
        settings.memory_enabled = false;
        session.features.summarizer = true;
        session.index.extend(entries.to_vec());
        session.index_ready = true;
        session
            .summaries
            .push(crate::context_db::StoredCompartment {
                sequence: 1,
                start_message: entries[0].ordinal as i64,
                end_message: end_entry.ordinal as i64,
                start_message_id: entries[0].mid.clone(),
                end_message_id: end.clone(),
                title: "Earlier work".into(),
                content: "A summary".into(),
                importance: 70,
                created_at: 40,
                ..Default::default()
            });
        let (ops, _) = session.history_ops(&settings, false);
        let cut = ops.iter().find_map(|op| match op {
            EditOp::Cut { through } => Some(through.clone()),
            _ => None,
        });
        put(format!("cut.{end}"), format!("{cut:?}"));
    }
    out
}

/// Every message id a present (carried) entry has, for summary endpoints.
pub(crate) fn present_mids(twin: &[Entry]) -> Vec<String> {
    twin.iter().map(|e| e.mid.clone()).collect()
}
