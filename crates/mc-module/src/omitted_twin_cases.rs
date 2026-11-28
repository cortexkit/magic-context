//! Compare request outputs with the same transcript after removing parts the
//! host never sent. Keep stored ordinals for readers that print them.

use super::omitted_twin_checks::*;
use cortexkit_role_compaction::part::{FileMedia, Part, PartBody, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::Role;
use serde_json::json;

fn text(id: &str, text: &str) -> Part {
    Part::new(id, PartBody::Text { text: text.into() })
}

fn tool(id: &str, name: &str, path: &str, status: ToolStatus, bytes: u64) -> Part {
    Part::new(
        id,
        PartBody::Tool(
            ToolPart::new(
                format!("call-{id}-{path}-{bytes}"),
                name,
                json!({"path": path, "oldString": "a", "newString": "b"}),
                status,
            )
            .with_output_bytes(bytes),
        ),
    )
}

fn reasoning(id: &str, bytes: u64, signed: bool) -> Part {
    Part::new(
        id,
        PartBody::Reasoning {
            text: None,
            text_bytes: Some(bytes),
        },
    )
    .with_seal(if signed { Seal::Signed } else { Seal::None })
}

fn image(id: &str) -> Part {
    Part::new(
        id,
        PartBody::File(FileMedia::inline("image/png", Some(2_000))),
    )
}

fn slot(role: Role, parts: Vec<(Part, bool)>) -> Slot {
    Slot {
        role,
        parts,
        notice: None,
    }
}

fn keep(p: Part) -> (Part, bool) {
    (p, false)
}

fn omit(p: Part) -> (Part, bool) {
    (p, true)
}

/// Cases covering omitted parts of every kind, as the only
/// part of an entry, as the last part of the last entry, as the first entry,
/// between a call and the next turn, and inside the cached summary window.
fn handcrafted() -> Vec<(String, Vec<Slot>)> {
    use Role::{Assistant as A, User as U};
    let big = 30_000;
    let mut cases = Vec::new();
    let prefix = |n: usize| -> Vec<Slot> {
        (0..n)
            .flat_map(|i| {
                [
                    slot(
                        U,
                        vec![keep(text(
                            "p0",
                            &format!("Please do task {i} in src/a.rs."),
                        ))],
                    ),
                    slot(
                        A,
                        vec![
                            keep(reasoning("p0", 3_000, i % 2 == 0)),
                            keep(text("p1", &format!("I committed abc{i:04}ef0 for it."))),
                            keep(tool("p2", "read", "src/a.rs", ToolStatus::Completed, big)),
                        ],
                    ),
                    slot(
                        A,
                        vec![keep(tool(
                            "p0",
                            "edit",
                            "src/a.rs",
                            ToolStatus::Completed,
                            2_000,
                        ))],
                    ),
                ]
            })
            .collect()
    };
    // A cut reply at the end: the calls that never ran are left out.
    for status in [
        ToolStatus::Running,
        ToolStatus::Error,
        ToolStatus::Denied,
        ToolStatus::Completed,
    ] {
        let mut s = prefix(6);
        s.push(slot(U, vec![keep(text("p0", "Now finish it."))]));
        s.push(slot(
            A,
            vec![
                keep(text("p0", "Starting.")),
                omit(tool("p1", "edit", "src/a.rs", status.clone(), 100)),
                omit(tool("p2", "read", "src/a.rs", status.clone(), 100)),
            ],
        ));
        cases.push((format!("cut-reply-last-part.{status:?}"), s));
        let mut s = prefix(6);
        s.push(slot(U, vec![keep(text("p0", "Now finish it."))]));
        s.push(slot(
            A,
            vec![
                omit(tool("p0", "edit", "src/a.rs", status.clone(), 100)),
                omit(tool("p1", "ctx_keep", "src/a.rs", status.clone(), 100)),
            ],
        ));
        cases.push((format!("cut-reply-whole-entry.{status:?}"), s));
        // Omitted entry between a call and the next turn.
        let mut s = prefix(6);
        s.push(slot(
            A,
            vec![keep(tool(
                "p0",
                "read",
                "src/b.rs",
                ToolStatus::Completed,
                500,
            ))],
        ));
        s.push(slot(
            A,
            vec![omit(tool("p0", "read", "src/b.rs", status.clone(), 500))],
        ));
        s.push(slot(U, vec![keep(text("p0", "Continue."))]));
        s.extend(prefix(2));
        cases.push((format!("omitted-between.{status:?}"), s));
    }
    // Omitted first entry (user task) and first assistant.
    for role in [U, A] {
        let mut s = vec![slot(
            role.clone(),
            vec![omit(text("p0", "The original task, never sent."))],
        )];
        s.extend(prefix(5));
        cases.push((format!("first-omitted.{role:?}"), s));
    }
    // Omitted only-part user entries of each kind.
    for (label, part) in [
        ("text", text("p0", "Omitted user words about src/a.rs")),
        ("image", image("p0")),
    ] {
        let mut s = prefix(4);
        s.push(slot(U, vec![omit(part)]));
        s.extend(prefix(2));
        cases.push((format!("user-only.{label}"), s));
    }
    // Omitted reasoning (signed and not), text and image beside kept parts.
    let mut s = prefix(3);
    s.push(slot(
        A,
        vec![
            omit(reasoning("p0", 8_000, true)),
            keep(text("p1", "Kept answer.")),
            omit(reasoning("p2", 8_000, false)),
            omit(text("p3", "I committed deadbeef123 in an omitted line.")),
        ],
    ));
    s.push(slot(
        U,
        vec![keep(text("p0", "Look at this")), omit(image("p1"))],
    ));
    s.extend(prefix(3));
    s.push(slot(
        A,
        vec![
            keep(text("p0", "Done.")),
            omit(reasoning("p1", 9_000, true)),
        ],
    ));
    cases.push(("mixed-kinds".into(), s));
    // Omitted named-protected calls newer than kept ones.
    let mut s = prefix(4);
    for i in 0..4 {
        s.push(slot(
            A,
            vec![omit(tool(
                "p0",
                "read",
                "src/c.rs",
                ToolStatus::Completed,
                4_000 + i,
            ))],
        ));
        s.push(slot(
            A,
            vec![omit(tool(
                "p0",
                "edit",
                "src/a.rs",
                ToolStatus::Completed,
                300 + i,
            ))],
        ));
    }
    s.push(slot(U, vec![keep(text("p0", "ok"))]));
    cases.push(("protected-quota".into(), s));
    // Omitted later successes and coverage for retries and reads.
    let mut s = prefix(5);
    s.push(slot(
        A,
        vec![keep(tool("p0", "read", "src/b.rs", ToolStatus::Error, 100))],
    ));
    s.extend(prefix(4));
    s.push(slot(
        A,
        vec![omit(tool(
            "p0",
            "read",
            "src/b.rs",
            ToolStatus::Completed,
            100,
        ))],
    ));
    s.push(slot(
        A,
        vec![omit(tool(
            "p0",
            "edit",
            "src/b.rs",
            ToolStatus::Completed,
            100,
        ))],
    ));
    s.extend(prefix(4));
    cases.push(("evidence-from-omitted".into(), s));
    // A long transcript with omitted rows spread through the cached window.
    let mut s = prefix(30);
    for (i, x) in s.iter_mut().enumerate() {
        if i % 7 == 3 {
            for p in &mut x.parts {
                p.1 = true;
            }
        }
    }
    cases.push(("window-spread".into(), s));
    // The first stored entry is omitted and the first carried one is an
    // assistant with large old outputs, which the first-message protection keeps.
    let mut s = vec![slot(U, vec![omit(text("p0", "Never sent."))])];
    s.push(slot(
        A,
        vec![
            keep(tool(
                "p0",
                "bash",
                "src/a.rs",
                ToolStatus::Completed,
                60_000,
            )),
            keep(text("p1", "First carried words, long enough to compress.")),
        ],
    ));
    s.extend(prefix(12));
    cases.push(("first-omitted-then-assistant".into(), s));
    // An image the newest carried assistant never answered: the only later
    // assistant entry is omitted.
    let mut s = prefix(5);
    s.push(slot(
        U,
        vec![keep(text("p0", "See image")), keep(image("p1"))],
    ));
    s.push(slot(
        A,
        vec![omit(tool("p0", "read", "src/a.rs", ToolStatus::Running, 0))],
    ));
    cases.push(("image-before-omitted-assistant".into(), s));
    // The last entry ends with an omitted call after a carried one, or an
    // omitted-only entry follows a carried call.
    for status in [ToolStatus::Completed, ToolStatus::Running] {
        let mut s = prefix(6);
        s.push(slot(
            A,
            vec![
                keep(tool("p0", "bash", "src/a.rs", ToolStatus::Completed, 9_000)),
                omit(tool("p1", "read", "src/b.rs", status.clone(), 9_000)),
            ],
        ));
        cases.push((format!("carried-call-then-omitted-call.{status:?}"), s));
        let mut s = prefix(6);
        s.push(slot(
            A,
            vec![keep(tool(
                "p0",
                "bash",
                "src/a.rs",
                ToolStatus::Completed,
                9_000,
            ))],
        ));
        s.push(slot(
            A,
            vec![omit(tool("p0", "read", "src/b.rs", status.clone(), 9_000))],
        ));
        cases.push((format!("carried-call-then-omitted-entry.{status:?}"), s));
    }
    // More than 15 assistant steps in the current turn, some omitted, with a
    // heavy signed step near the window's edge.
    let mut s = prefix(2);
    s.push(slot(U, vec![keep(text("p0", "Long turn."))]));
    s.push(slot(
        A,
        vec![
            keep(reasoning("p0", 40_000, true)),
            keep(text("p1", "thinking hard")),
        ],
    ));
    for i in 0..16u64 {
        let call = tool("p0", "read", "src/c.rs", ToolStatus::Completed, 100 + i);
        s.push(slot(
            A,
            vec![if i % 3 == 0 { omit(call) } else { keep(call) }],
        ));
    }
    cases.push(("heavy-window".into(), s));
    // Unkept and kept notices, one of them omitted.
    let mut s = prefix(4);
    let mut notice = slot(U, vec![keep(text("p0", &"Reminder text. ".repeat(400)))]);
    notice.notice = Some(false);
    s.push(notice.clone());
    let mut omitted_notice = slot(U, vec![omit(text("p0", &"Omitted reminder. ".repeat(400)))]);
    omitted_notice.notice = Some(false);
    s.push(omitted_notice);
    s.extend(prefix(6));
    s.push(notice);
    s.extend(prefix(6));
    cases.push(("notices".into(), s));
    // A frame's words and a sibling's words follow the same omission rule.
    // When the frame is absent it does not change the sibling's attribution.
    for omit_frame in [false, true] {
        let mut s = prefix(3);
        let pair = vec![
            keep(text("before", "Before the steer.")),
            (
                framed_text("Use commit abc1234 in the new branch."),
                omit_frame,
            ),
            omit(text("after", "An omitted sibling calls it deadbeef.")),
        ];
        s.push(slot(U, pair));
        s.push(slot(
            U,
            vec![
                keep(text("host-bookkeeping", "Waiting for the host.")),
                omit(text("authored", "A cut user message.")),
            ],
        ));
        s.push(slot(
            U,
            vec![omit(text("host-bookkeeping", "Only host bookkeeping."))],
        ));
        s.extend(prefix(4));
        cases.push((format!("host-frame.{omit_frame}"), s));
    }
    let mut s = prefix(6);
    s.push(slot(
        U,
        vec![
            omit(text(
                "inbox",
                "<system-reminder>\nInbox:\nfrom Worker: old result\n</system-reminder>",
            )),
            keep(text("prompt", "Proceed with the unit tests.")),
            omit(text(
                "injection",
                "<system-reminder>Do not display this region.</system-reminder>",
            )),
        ],
    ));
    s.push(slot(
        A,
        vec![
            keep(text("sealed", "This answer is final.").with_seal(Seal::Encrypted)),
            omit(tool(
                "unfinished",
                "read",
                "src/a.rs",
                ToolStatus::Running,
                0,
            )),
        ],
    ));
    cases.push(("injected-relay-sealed-final".into(), s));
    let mut s = vec![slot(U, vec![omit(text("absent-first", "Not sent"))])];
    s.push(slot(
        A,
        vec![
            keep(image("image")),
            keep(text("first-real", "The first visible entry.")),
        ],
    ));
    s.extend(prefix(6));
    s.push(slot(
        A,
        vec![keep(tool(
            "keep",
            "ctx_keep",
            "src/a.rs",
            ToolStatus::Completed,
            100,
        ))],
    ));
    cases.push(("first-carried-image-before-keep".into(), s));
    cases
}

pub(crate) fn corpus(scale: u64) -> Vec<(String, Vec<Slot>, bool)> {
    let mut cases = Vec::new();
    for (name, slots) in handcrafted() {
        cases.push((format!("{name}.tagged"), slots.clone(), true));
        cases.push((format!("{name}.untagged"), slots, false));
    }
    for seed in 0..scale {
        for (len, omit, whole) in [
            (1usize, 50u64, 50u64),
            (2, 40, 40),
            (5, 30, 25),
            (14, 20, 15),
            (40, 15, 10),
            (90, 10, 10),
        ] {
            let slots = generate(seed * 131 + len as u64, len, omit, whole);
            cases.push((format!("gen.{seed}.{len}"), slots, seed % 2 == 0));
        }
    }
    cases
}

/// The checks whose marked and twin values differ, with both values.
pub(crate) fn compare(slots: &[Slot], tag_omitted: bool) -> Vec<(String, String, String)> {
    compare_checks(slots, tag_omitted, [true; 3])
}

pub(crate) fn compare_checks(
    slots: &[Slot],
    tag_omitted: bool,
    [index, slice, session]: [bool; 3],
) -> Vec<(String, String, String)> {
    let (marked, renum, gap) = materialize(slots, tag_omitted);
    let mut diffs = Vec::new();
    let mut diff = |prefix: &str, a: Checks, b: Checks| {
        let bmap: std::collections::BTreeMap<_, _> = b.into_iter().collect();
        for (k, va) in a {
            let vb = bmap.get(&k).cloned().unwrap_or_else(|| "<missing>".into());
            if va != vb {
                // For views, show only the edits one side has.
                let parsed = (
                    serde_json::from_str::<Vec<serde_json::Value>>(&va),
                    serde_json::from_str::<Vec<serde_json::Value>>(&vb),
                );
                if let (Ok(ea), Ok(eb)) = parsed {
                    let only_a: Vec<_> = ea
                        .iter()
                        .filter(|op| !eb.contains(op))
                        .map(|op| op.to_string())
                        .collect();
                    let only_b: Vec<_> = eb
                        .iter()
                        .filter(|op| !ea.contains(op))
                        .map(|op| op.to_string())
                        .collect();
                    diffs.push((
                        format!("{prefix}{k}"),
                        format!("only marked: {only_a:?}"),
                        format!("only twin: {only_b:?}"),
                    ));
                    continue;
                }
                diffs.push((format!("{prefix}{k}"), va, vb));
            }
        }
    };
    if renum.is_empty() {
        if index {
            diff(
                "",
                index_checks(&marked, false),
                index_checks(&renum, false),
            );
        }
        return diffs;
    }
    if index {
        for kf in [false, true] {
            diff(
                if kf { "kf." } else { "" },
                index_checks(&marked, kf),
                index_checks(&renum, kf),
            );
        }
    }
    if slice {
        diff("", slice_checks(&marked), slice_checks_with(&gap, true));
    }
    if session {
        let present = present_mids(&renum);
        let ends = [0, present.len() / 2, present.len() - 1].map(|i| present[i].clone());
        diff(
            "",
            session_checks(&marked, &ends),
            session_checks(&renum, &ends),
        );
    }
    diffs
}

#[test]
fn omitted_generated_request_twins() {
    let cases = corpus(8);
    let mut failures = Vec::new();
    for (name, slots, tag_omitted) in &cases {
        let differences = compare(slots, *tag_omitted);
        if !differences.is_empty() {
            failures.push((
                name,
                differences.len(),
                differences.into_iter().take(3).collect::<Vec<_>>(),
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} transcripts diverged: {:#?}",
        failures.len(),
        cases.len(),
        failures.iter().take(8).collect::<Vec<_>>()
    );
}
