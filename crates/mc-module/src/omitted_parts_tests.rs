use super::*;
use crate::summary::{chunk, due::Window};
use cortexkit_role_compaction::part::{body_digest, FileMedia, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::entry_digest;
use serde_json::json;
use std::collections::BTreeMap;

const BORN: &str = include_str!("../testdata/omitted-parts/omitted-parts-born.json");
const SETTLEMENT: &str = include_str!("../testdata/omitted-parts/notice-omitted-settlement.json");
const REFUSAL: &str = include_str!("../testdata/omitted-parts/view-omitted-part-refused.json");

fn line(id: &str, tag: u64, text: &str) -> Part {
    crate::neutral::part(
        id,
        Some(tag),
        Seal::None,
        PartBody::Text { text: text.into() },
    )
}

fn call(id: &str, tag: u64, name: &str, status: ToolStatus) -> Part {
    crate::neutral::part(
        id,
        Some(tag),
        Seal::None,
        PartBody::Tool(
            ToolPart::new(id, name, json!({"path":"work.rs"}), status).with_output_bytes(4_000),
        ),
    )
}

fn omit(mut part: Part) -> Part {
    part.omitted = true;
    part.tag = None;
    part.tokens = None;
    part
}

fn row(n: u64, role: Role, parts: Vec<Part>) -> Entry {
    Entry::new(n, format!("m{n}"), role, n, parts)
}

fn without_omitted(entries: &[Entry]) -> Vec<Entry> {
    entries
        .iter()
        .filter(|entry| entry.parts.is_empty() || entry.parts.iter().any(|part| !part.omitted))
        .cloned()
        .map(|mut entry| {
            entry.parts.retain(|part| !part.omitted);
            entry.digest = entry_digest(entry.role.clone(), entry.notice.as_ref(), &entry.parts);
            entry
        })
        .collect()
}

fn on_both<T: std::fmt::Debug + PartialEq>(entries: &[Entry], output: impl Fn(&[Entry]) -> T) {
    assert_eq!(output(entries), output(&without_omitted(entries)));
}

fn select<T>(entries: &[Entry], f: impl FnOnce(&lanes::Context<'_>) -> T) -> T {
    let mut index = Index::default();
    index.extend(entries.iter().cloned());
    f(&lanes::Context {
        index: &index,
        edited: &lanes::Edited::default(),
        protected_tools: &BTreeMap::new(),
        keep_first_message: false,
        signed_floor: None,
    })
}

#[test]
fn omitted_guard_01_request_weights() {
    // Count both numbered kinds: text and a tool the runner would execute.
    let entries = [row(
        1,
        Role::Assistant,
        vec![
            line("real", 1, "A bit of text"),
            omit(line(
                "fragment",
                2,
                "A large cut reply that has no request weight",
            )),
            omit(call("unfinished", 3, "read", ToolStatus::Error)),
        ],
    )];
    on_both(&entries, |entries| {
        (entry_tokens(&entries[0]), entry_removed_tokens(&entries[0]))
    });
}

#[test]
fn omitted_guard_02_superseded_edits() {
    let mut entries = vec![row(
        1,
        Role::Assistant,
        vec![call("old", 1, "edit", ToolStatus::Completed)],
    )];
    entries.extend((2..=22).map(|n| row(n, Role::Assistant, vec![line("text", n, "later")])));
    entries.push(row(
        23,
        Role::Assistant,
        vec![omit(call("fake-edit", 23, "edit", ToolStatus::Error))],
    ));
    on_both(&entries, |entries| {
        select(entries, |ctx| lanes::superseded_edits(ctx, None, 1))
    });
}

#[test]
fn omitted_guard_03_repeated_reads() {
    let entries = [
        row(
            1,
            Role::Assistant,
            vec![call("old", 1, "read", ToolStatus::Completed)],
        ),
        row(
            2,
            Role::Assistant,
            vec![omit(call("fake-read", 2, "read", ToolStatus::Completed))],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |ctx| lanes::superseded_reads(ctx, None))
    });
}

#[test]
fn omitted_guard_04_failed_call_retries() {
    let entries = [
        row(
            1,
            Role::Assistant,
            vec![call("old-error", 1, "read", ToolStatus::Error)],
        ),
        row(
            2,
            Role::Assistant,
            vec![omit(call("fake-retry", 2, "read", ToolStatus::Completed))],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |ctx| lanes::retried_failures(ctx, None))
    });
}

#[test]
fn omitted_guard_05_answered_images() {
    let entries = [
        row(
            1,
            Role::User,
            vec![
                line("question", 1, "What does this image show?"),
                Part::new(
                    "image",
                    PartBody::File(FileMedia::inline("image/png", Some(300))),
                ),
            ],
        ),
        row(
            2,
            Role::Assistant,
            vec![omit(line("lost-answer", 2, "A cut reply"))],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |ctx| {
            lanes::answered_images(
                ctx,
                &lanes::Images {
                    outputs: &BTreeMap::new(),
                    watermark: 1,
                    cutoff: None,
                    over_limit: false,
                    skip: &[],
                },
            )
        })
    });
}

#[test]
fn omitted_guard_06_named_tool_quota() {
    let entries = [
        row(
            1,
            Role::Assistant,
            vec![call("real", 1, "read", ToolStatus::Completed)],
        ),
        row(
            2,
            Role::Assistant,
            vec![omit(call("fake-slot", 2, "read", ToolStatus::Error))],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |ctx| {
            lanes::protected_tool_parts(ctx.index, &BTreeMap::from([("read".into(), 1)]))
        })
    });
}

#[test]
fn omitted_guard_07_request_tail_shape() {
    let entries = [
        row(1, Role::User, vec![line("first", 1, "begin")]),
        row(
            2,
            Role::Assistant,
            vec![
                call("last-real-tool", 2, "read", ToolStatus::Completed),
                omit(call("fake-keep", 3, "ctx_keep", ToolStatus::Completed)),
            ],
        ),
        row(
            3,
            Role::User,
            vec![omit(line("fake-turn", 4, "not a user turn"))],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |ctx| {
            let drop = [(("m2".into(), "last-real-tool".into()), lanes::Shape::Whole)];
            (
                lanes::drop_ops(ctx, &drop),
                lanes::keep_call(ctx.index).map(|entry| entry.mid.clone()),
                crate::pass::current_turn_start(entries),
            )
        })
    });
}

#[test]
fn omitted_guard_08_cut_ignores_running_omitted_calls() {
    let entries = [
        row(
            1,
            Role::User,
            vec![
                line("first", 1, "begin"),
                omit(call("running", 2, "read", ToolStatus::Running)),
            ],
        ),
        row(2, Role::User, vec![line("last", 2, "continue")]),
    ];
    let cut = |entries: &[Entry]| {
        let (mut session, _, _, _, mut settings) = fixture();
        session.features.summarizer = true;
        settings.memory_enabled = false;
        session.index.extend(entries.iter().cloned());
        session.numbers_covered = Some(MoveFloor {
            ordinal: 1,
            mid: "m1".into(),
        });
        session.history_ops(&settings, false).1
    };
    assert_eq!(cut(&without_omitted(&entries)), Some(1));
    on_both(&entries, cut);
}

#[test]
fn omitted_guard_09_signed_hold_steps() {
    let reasoning: Part = serde_json::from_value(json!({
        "id":"thinking", "kind":"reasoning", "seal":"signed", "text_bytes":8_000, "digest":""
    }))
    .unwrap();
    let mut entries = vec![
        row(1, Role::User, vec![line("question", 1, "begin")]),
        row(2, Role::Assistant, vec![reasoning]),
    ];
    entries.extend((3..=17).map(|n| row(n, Role::Assistant, vec![omit(line("absent", n, "cut"))])));
    let (mut session, _, _, _, _) = fixture();
    session.conditions.rules.signed_parts = SignedParts::Bound;
    let held =
        |entries: &[Entry]| crate::pass::heavy_signed_turn(entries, &session.conditions, None);
    assert!(held(&without_omitted(&entries)));
    on_both(&entries, held);
}

#[test]
fn omitted_guard_10_search_already_visible() {
    let entries = [
        row(1, Role::User, vec![line("visible", 1, "real")]),
        row(
            2,
            Role::Assistant,
            vec![omit(line("fragment", 2, "a failed fragment"))],
        ),
    ];
    on_both(&entries, |entries| {
        let (mut session, _, _, _, settings) = fixture();
        session.index.extend(entries.iter().cloned());
        session
            .search_scope(&settings, &BTreeMap::new())
            .visible_messages
    });
}

#[test]
fn omitted_guard_11_generated_historian_chunks() {
    for seed in 0..64 {
        let mut entries = vec![row(1, Role::User, vec![line("question", 1, "begin")])];
        entries.extend((2..=9).map(|n| {
            row(
                n,
                Role::Assistant,
                vec![
                    line(
                        "real",
                        n,
                        &format!("Visible progress for seed {seed}, step {n}."),
                    ),
                    omit(line(
                        "fragment",
                        0,
                        &"Unsent fragment. ".repeat((seed + n as usize) % 13 + 1),
                    )),
                    omit(call("fake", 0, "edit", ToolStatus::Error)),
                ],
            )
        }));
        entries.push(row(
            10,
            Role::Assistant,
            vec![omit(call("cut", 0, "read", ToolStatus::Error))],
        ));
        on_both(&entries, |entries| {
            let counter = crate::count::Counter::for_model(None);
            [chunk::Lines::Merged, chunk::Lines::PerMessage]
                .map(|mode| chunk::build_with(entries, 2_000, mode, counter))
        });
        on_both(&entries, |entries| {
            let weights: Vec<_> = entries
                .iter()
                .filter(|entry| !crate::neutral::is_absent_from_request(entry))
                .map(|entry| (entry_tokens(entry), entry_removed_tokens(entry)))
                .collect();
            let (ops, _) = select(entries, |ctx| {
                lanes::drop_ops(
                    ctx,
                    &[
                        (("m2".into(), "real".into()), lanes::Shape::Requested),
                        (("m3".into(), "fragment".into()), lanes::Shape::Requested),
                    ],
                )
            });
            let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
            let view =
                crate::view_builder::next_view(None, entries, ops, &rules, 1, |_| false).unwrap();
            (weights, view, crate::summary::hashes::by_ordinal(entries))
        });
    }
}

#[test]
fn historian_cached_window_rewinds_before_first_visible_block_on_replacement() {
    let entries = [
        row(
            1,
            Role::User,
            vec![omit(line("cut", 0, "Discarded first attempt."))],
        ),
        row(
            2,
            Role::Assistant,
            vec![line("existing", 1, "The existing line.")],
        ),
    ];
    let replacement = row(
        1,
        Role::User,
        vec![line("replacement", 2, "A new question from the person.")],
    );
    let counter = crate::count::Counter::for_model(None);
    let mut window = Window::default();
    let mut counts = chunk::CountCache::default();
    window.sync(&entries, 1, None, 1, counter, &mut counts);
    let first = window
        .scan(&entries, 1, 3, 5_000, counter, &mut counts)
        .unwrap();
    assert_eq!(first.messages, 1, "the absent row must not prime a block");

    let after = [replacement, entries[1].clone()];
    window.sync(&after, 1, Some(1), 1, counter, &mut counts);
    let updated = window
        .scan(&after, 1, 3, 5_000, counter, &mut counts)
        .unwrap();
    let mut fresh = Window::default();
    let mut counts = chunk::CountCache::default();
    fresh.sync(&after, 1, None, 1, counter, &mut counts);
    assert_eq!(updated.messages, 2);
    assert_eq!(
        Some(updated),
        fresh.scan(&after, 1, 3, 5_000, counter, &mut counts)
    );
}

fn settlement_vector() -> (NoticeRequest, NoticeRequest) {
    let example: Value = serde_json::from_str(SETTLEMENT).unwrap();
    let decode = |key: &str| serde_json::from_value(example[key]["params"].clone()).unwrap();
    (decode("before"), decode("after"))
}

#[test]
fn published_omission_examples_keep_the_wire_facts_and_checksums() {
    let born: Value = serde_json::from_str(BORN).unwrap();
    let entries: Vec<Entry> = serde_json::from_value(born["entries"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&entries).unwrap(), born["entries"]);
    assert_eq!(
        entries
            .iter()
            .flat_map(|entry| &entry.parts)
            .filter(|part| part.omitted)
            .count(),
        3
    );
    for part in entries
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter(|part| part.omitted)
    {
        assert_eq!((part.tag, part.tokens), (None, None));
        assert!(part.compact().omitted);
    }
    let (before, after) = settlement_vector();
    let old_call = &before.entries[0].parts[1];
    let new_call = &after.entries[0].parts[1];
    assert_ne!(old_call.digest, new_call.digest);
    assert_ne!(before.entries[0].digest, after.entries[0].digest);
    assert_eq!(
        before.entries[1].parts[0].digest,
        after.entries[1].parts[0].digest
    );
    assert_ne!(before.entries[1].digest, after.entries[1].digest);
    for part in [old_call, new_call] {
        assert_eq!(body_digest(part.seal.clone(), &part.body), part.digest);
        let mut flipped = part.clone();
        flipped.omitted = !flipped.omitted;
        assert_eq!(
            entry_digest(Role::Assistant, None, std::slice::from_ref(part)),
            entry_digest(Role::Assistant, None, &[flipped])
        );
    }
    // A tool part without an established number still changes identity because
    // the tool's status changes inside its digest.
    let unnumbered = |part: &Part| {
        let mut part = part.clone();
        part.tag = None;
        entry_digest(Role::Assistant, None, &[part])
    };
    assert_ne!(unnumbered(old_call), unnumbered(new_call));
    let refusal: Value = serde_json::from_str(REFUSAL).unwrap();
    let request: ApplyViewRequest =
        serde_json::from_value(refusal["request"]["params"].clone()).unwrap();
    let answer: ApplyViewAnswer = serde_json::from_value(refusal["answer"].clone()).unwrap();
    assert!(request.view.verify());
    assert!(matches!(
        answer,
        ApplyViewAnswer::Refused {
            refusal: ViewRefusal::OmittedPart { .. }
        }
    ));
}

#[tokio::test]
async fn omitted_settlement_notice_ingests_the_complete_packaged_suffix_without_a_read() {
    check_settlement(false).await;
}

#[tokio::test]
async fn omitted_settlement_notice_budget_fallback_reads_from_the_changed_ordinal() {
    check_settlement(true).await;
}

async fn check_settlement(elide_suffix: bool) {
    let (mut before, mut after) = settlement_vector();
    let (mut session, client, route, mut setup, settings) = fixture();
    let prefix = text(1, "prefix");
    *client.entries.lock().unwrap() = vec![prefix.clone()];
    setup.newest = Some(cursor(&prefix));
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    before.conditions = session.conditions.clone();
    after.conditions = before.conditions.clone();
    client
        .entries
        .lock()
        .unwrap()
        .extend(before.entries.clone());
    session.notice(&client, &settings, before).await;

    let running = ("reply".to_owned(), "pending".to_owned());
    let later = ("queued".to_owned(), "queued-text".to_owned());
    let queued = BTreeSet::from([running.clone(), later.clone()]);
    assert!(session
        .ctx_reduce(&client, &json!({"drop":"3-4"}))
        .await
        .unwrap()
        .contains("2 tags stamped"));
    assert_eq!(session.queued, queued);
    assert!(session.app.stamps.contains_key(&running));
    session.pending_keep = Some(queued);
    client.reads.lock().unwrap().clear();
    *client.entries.lock().unwrap() = std::iter::once(prefix)
        .chain(after.entries.clone())
        .collect();
    if elide_suffix {
        after.entries.clear();
    }
    session.notice(&client, &settings, after).await;
    {
        let reads = client.reads.lock().unwrap();
        if elide_suffix {
            assert_eq!(
                reads.len(),
                1,
                "expected only the missing suffix read: {reads:?}"
            );
            assert!(matches!(
                reads[0].select,
                Select::After {
                    after_ordinal: Some(1),
                    ..
                }
            ));
        } else {
            assert!(
                reads.is_empty(),
                "the full notice already supplied the suffix: {reads:?}"
            );
        }
    }
    let recounted = session.index.find_tag(3).unwrap();
    assert_eq!((&recounted.0.mid, &recounted.1.id), (&later.0, &later.1));
    assert!(session.index.find_tag(4).is_none());
    assert!(
        session
            .index
            .find(&running.0, &running.1)
            .unwrap()
            .1
            .omitted
    );
    assert_eq!(session.queued, BTreeSet::from([later.clone()]));
    assert_eq!(session.pending_keep, Some(BTreeSet::from([later.clone()])));
    assert!(!session.app.stamps.contains_key(&running));
    assert!(session.app.stamps.contains_key(&later));
    let (costs, _) = session.served_costs(std::iter::empty());
    assert!(!costs.contains_key(&running));
    assert!(costs[&later] > 0);
    let snapshot = session.app_snapshot();
    let row = &snapshot.messages["reply"].row;
    assert_eq!(row["parts"]["stamped"], 0);
    assert_eq!(row["items"][1]["not_sent"], true);
    assert_eq!(row["items"][1]["tokens"], 0);
    assert!(session
        .ctx_reduce(&client, &json!({"drop":"4"}))
        .await
        .unwrap()
        .starts_with("Error: Unknown tag(s)"));
    assert!(session
        .tool(&client, &settings, "ctx_expand", &json!({"tag":4}))
        .await
        .unwrap()
        .contains("no tag 4"));
}

#[tokio::test]
async fn omitted_born_parts_stay_in_app_rows_and_raw_expansion() {
    let born: Value = serde_json::from_str(BORN).unwrap();
    let entries: Vec<Entry> = serde_json::from_value(born["entries"].clone()).unwrap();
    let (mut session, client, route, mut setup, settings) = fixture();
    *client.entries.lock().unwrap() = entries.clone();
    setup.newest = entries.last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    let snapshot = session.app_snapshot();
    let items = snapshot.messages["cut-reply"].row["items"]
        .as_array()
        .unwrap();
    assert_eq!(items.len(), 2);
    for item in items {
        assert_eq!(item["not_sent"], true);
        assert_eq!(item["tokens"], 0);
        assert_eq!(item["state"], "live");
    }
    let sample: Value = serde_json::from_str(include_str!(
        "../testdata/omitted-parts/app-not-sent-rows.json"
    ))
    .unwrap();
    for name in ["cut-reply", "cut-final"] {
        assert_eq!(snapshot.messages[name].row, sample[name]);
    }
    for input in [
        json!({"message":2}),
        json!({"start":2,"end":2}),
        json!({"start":2,"end":2,"verbose":true}),
    ] {
        let expanded = session
            .tool(&client, &settings, "ctx_expand", &input)
            .await
            .unwrap();
        assert_eq!(
            expanded.matches("(not sent to the model)").count(),
            2,
            "{expanded}"
        );
        assert!(expanded.contains("I will read the file."), "{expanded}");
        assert!(expanded.contains("example.txt"), "{expanded}");
    }
    assert!(session
        .ctx_reduce(&client, &json!({"drop":"9"}))
        .await
        .unwrap()
        .starts_with("Error: Unknown tag(s)"));
}

#[test]
fn omitted_targets_never_leave_the_view_builder_even_as_carried_edits() {
    let born: Value = serde_json::from_str(BORN).unwrap();
    let entries: Vec<Entry> = serde_json::from_value(born["entries"].clone()).unwrap();
    let refusal: Value = serde_json::from_str(REFUSAL).unwrap();
    let request: ApplyViewRequest =
        serde_json::from_value(refusal["request"]["params"].clone()).unwrap();
    let whole = EditOp::Drop {
        mid: "cut-final".into(),
        part: None,
    };
    let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
    let view = crate::view_builder::next_view(
        Some(&request.view),
        &entries,
        vec![whole],
        &rules,
        request.view.version + 1,
        |_| false,
    )
    .unwrap()
    .unwrap();
    assert!(view.edits.is_empty(), "{view:?}");
}

#[tokio::test]
async fn published_omitted_part_refusal_blames_only_the_named_part() {
    let vector: Value = serde_json::from_str(REFUSAL).unwrap();
    let request: ApplyViewRequest =
        serde_json::from_value(vector["request"]["params"].clone()).unwrap();
    let answer: ApplyViewAnswer = serde_json::from_value(vector["answer"].clone()).unwrap();
    let ApplyViewAnswer::Refused {
        refusal: ViewRefusal::OmittedPart { mid, part },
    } = answer
    else {
        panic!("the example must name an omitted part");
    };
    let target = (mid.clone(), part.clone());
    let other = ("other".to_owned(), "kept".to_owned());
    for refusal in [
        ViewRefusal::UnknownPart {
            mid: mid.clone(),
            part: part.clone(),
        },
        ViewRefusal::OmittedPart { mid, part },
    ] {
        let (mut session, client, _, _, _) = fixture();
        session.queued.extend([target.clone(), other.clone()]);
        session.next_covered = vec![target.clone()];
        *client.refuse.lock().unwrap() = true;
        *client.refusal.lock().unwrap() = Some(refusal);
        assert!(!session.publish(&client, request.view.clone()).await);
        assert!(session.latest.is_none());
        assert_eq!(
            session.queued,
            BTreeSet::from([target.clone(), other.clone()])
        );
        assert_eq!(session.refused_once, BTreeSet::from([target.clone()]));
    }
}

#[test]
fn omitted_final_turn_pair_is_refused_for_both_transcripts() {
    use cortexkit_role_compaction::rules::RuleBreak;
    let entries = [
        row(1, Role::User, vec![line("p0", 1, "Do the task.")]),
        row(
            2,
            Role::Assistant,
            vec![
                line("p0", 2, "Partial answer before the cut."),
                omit(call("omit-p1", 0, "edit", ToolStatus::Running)),
            ],
        ),
    ];
    let result = |entries: &[Entry]| {
        crate::view_builder::next_view(
            None,
            entries,
            vec![EditOp::Drop {
                mid: "m2".into(),
                part: Some("p0".into()),
            }],
            &ProviderRules::new(SignedParts::None, EditCost::Suffix),
            1,
            |_| false,
        )
    };
    assert_eq!(
        result(&entries),
        Err(ViewRefusal::Rule(RuleBreak::FinalTurnRemoved { index: 0 }))
    );
    on_both(&entries, result);
}

#[test]
fn omitted_signed_companion_pair_needs_no_drop_for_the_omitted_part() {
    let entries = [
        row(1, Role::User, vec![line("p0", 1, "Old words.")]),
        row(
            2,
            Role::Assistant,
            vec![
                omit(
                    Part::new(
                        "omit-p0",
                        PartBody::Reasoning {
                            text: None,
                            text_bytes: Some(4_000),
                        },
                    )
                    .with_seal(Seal::Signed),
                ),
                line("p1", 2, "Kept answer."),
            ],
        ),
        row(3, Role::User, vec![line("p0", 3, "Next prompt.")]),
    ];
    let remove = EditOp::Drop {
        mid: "m1".into(),
        part: Some("p0".into()),
    };
    on_both(&entries, |entries| {
        let view = crate::view_builder::next_view(
            None,
            entries,
            vec![remove.clone()],
            &ProviderRules::new(SignedParts::Bound, EditCost::Suffix),
            1,
            |_| false,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            view.edits.iter().map(|edit| &edit.op).collect::<Vec<_>>(),
            [&remove]
        );
        view
    });
}

#[test]
fn history_wait_ignores_a_new_omitted_only_row() {
    let (mut session, _, _, _, _) = fixture();
    session.index.extend([text(1, "visible")]);
    session.no_progress = Some(("visible".into(), false));
    session.index.extend([row(
        2,
        Role::Assistant,
        vec![omit(line("cut", 0, "Cut before sending."))],
    )]);
    assert!(session.waits_for_new_history(false));
    session.index.extend([text(3, "new prompt")]);
    assert!(!session.waits_for_new_history(false));
}

#[test]
fn omitted_running_call_cannot_block_the_numbers_floor_or_the_cut() {
    let (mut session, _, _, _, mut settings) = fixture();
    session.features.summarizer = true;
    settings.memory_enabled = false;
    let mut marked = row(
        1,
        Role::Assistant,
        vec![
            Part::new(
                "kept",
                PartBody::Text {
                    text: "Actual history.".into(),
                },
            ),
            omit(call("omitted", 0, "read", ToolStatus::Running)),
        ],
    );
    marked.numbers_unknown = true;
    session.index.extend([marked, text(2, "Continue")]);
    session.numbers_covered = Some(MoveFloor {
        ordinal: 1,
        mid: "m1".into(),
    });
    assert_eq!(session.numbers_floor().unwrap().ordinal, 1);
    assert!(session.running_call_below_numbers_floor().is_none());
    assert_eq!(session.history_ops(&settings, false).1, Some(1));
}

#[tokio::test]
async fn omission_does_not_change_clock_notes_on_carried_tool_turns() {
    for should_send in [false, true] {
        let (mut session, client, _, _, mut settings) = fixture();
        settings.clock_note = Some(60_000);
        client.descriptions.lock().unwrap().push_back(Ok(
            json!({"capabilities":["delivery_order","template_datetime"]}),
        ));
        session.index.extend([text(1, "Question")]);
        if should_send {
            session.index.extend([
                row(
                    2,
                    Role::Assistant,
                    vec![call("real", 2, "read", ToolStatus::Completed)],
                ),
                row(3, Role::User, vec![omit(line("cut", 0, "Not carried"))]),
            ]);
        } else {
            session.index.extend([row(
                2,
                Role::Assistant,
                vec![
                    line("reply", 2, "Text only"),
                    omit(call("cut", 0, "read", ToolStatus::Completed)),
                ],
            )]);
        }
        session.send_clock_note_if_due(&client, &settings).await;
        let sent = client.sent.lock().unwrap();
        assert_eq!(sent.len(), usize::from(should_send));
        if let Some(request) = sent.first() {
            let delivery = request.delivery_order().unwrap().unwrap();
            assert_eq!(delivery.template.unwrap().id, crate::clock_note::TEMPLATE);
        }
    }
}

#[tokio::test]
async fn omitted_parts_are_not_addressable_even_in_a_bad_named_read() {
    let (mut session, client, _, _, settings) = fixture();
    session.index_ready = true;
    let mut bad_part = omit(line("bad", 0, "The runner should not tag this."));
    bad_part.tag = Some(777);
    let record = row(1, Role::Assistant, vec![bad_part]);
    for tool in ["ctx_expand", "ctx_reduce"] {
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(vec![record.clone()], Head::new())));
        let request = if tool == "ctx_expand" {
            json!({"tag":777})
        } else {
            json!({"drop":"777"})
        };
        let output = session
            .tool(&client, &settings, tool, &request)
            .await
            .unwrap();
        if tool == "ctx_expand" {
            assert!(output.starts_with("no tag 777"), "{output}");
        } else {
            assert!(output.starts_with("Error: Unknown tag(s)"), "{output}");
        }
        assert!(session.queued.is_empty());
    }
}

#[tokio::test]
async fn omission_keeps_first_message_protection_and_replays_a_published_view_on_undo() {
    let (mut session, client, route, mut setup, settings) = fixture();
    session.features.keep_first_message = true;
    let absent = row(
        1,
        Role::Assistant,
        vec![omit(line("absent", 0, "Cut first reply"))],
    );
    let first = row(
        2,
        Role::Assistant,
        vec![line("first", 1, "First carried reply")],
    );
    let old = row(
        3,
        Role::Assistant,
        vec![line("old", 2, "An older carried reply")],
    );
    let next = row(
        4,
        Role::Assistant,
        vec![call("keep", 3, "ctx_keep", ToolStatus::Completed)],
    );
    let entries = [absent, first, old, next];
    *client.entries.lock().unwrap() = entries.to_vec();
    setup.newest = entries.last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop":"1"}))
        .await
        .unwrap();
    assert!(
        session.queued.is_empty(),
        "the first carried message remains protected"
    );
    session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &json!({"tags":"1","note":"The first answer stays."}),
        )
        .await
        .unwrap();
    assert!(session
        .pending_keep
        .as_ref()
        .is_some_and(|parts| parts.contains(&("m2".into(), "first".into()))));
    let kept = session.ready_keep(false).cloned().unwrap();
    let view = session
        .build(&settings, None, false, Some(&kept))
        .0
        .unwrap();
    assert!(!view.edits.is_empty());
    assert!(session.publish(&client, view.clone()).await);
    session.settle_unconfirmed(Some(&view.applied()), &[]);
    assert!(session.build(&settings, None, false, None).0.is_none());

    let mut omitted_but_tagged = omit(line("invalid", 0, "Held defensive fixture"));
    omitted_but_tagged.tag = Some(999);
    let before_undo = row(5, Role::Assistant, vec![omitted_but_tagged]);
    let undone = text(6, "undone");
    session.index.extend([before_undo.clone(), undone]);
    session.reclaim_bookmark = 1_000;
    client.entries.lock().unwrap().push(before_undo.clone());
    let mut undo = notice(&session, 1, Some(cursor(&before_undo)));
    undo.applied_view = Some(view.applied());
    undo.events
        .push(Event::TranscriptChanged { from_ordinal: 6 });
    session.notice(&client, &settings, undo).await;
    assert_eq!(session.reclaim_bookmark, 3);
    assert!(session.index.ends_at(Some(&cursor(&before_undo))));
    assert_eq!(session.latest.as_ref().map(|v| &v.edits), Some(&view.edits));
}

#[test]
fn a_whole_message_edit_does_not_make_omitted_parts_part_of_the_watermark() {
    use cortexkit_role_compaction::view::Edit;
    let mut invalid = omit(line("not-sent", 0, "Not part of this view's request."));
    invalid.tag = Some(999);
    let entries = [
        row(
            1,
            Role::Assistant,
            vec![line("visible", 1, "Sent"), invalid],
        ),
        text(2, "Keep this"),
    ];
    let mut index = Index::default();
    index.extend(entries);
    let view = View::seal(
        1,
        vec![Edit::new(
            1,
            EditOp::Drop {
                mid: "m1".into(),
                part: None,
            },
        )],
    );
    assert_eq!(
        lanes::Edited::of(Some(&view), &index, None).watermark(&index),
        1
    );
}

#[test]
fn a_window_without_carried_history_has_no_read_range() {
    let entries = [row(
        1,
        Role::Assistant,
        vec![omit(line("cut", 0, "Unsent"))],
    )];
    let mut window = Window::default();
    let counter = crate::count::Counter::for_model(None);
    let mut counts = chunk::CountCache::default();
    window.sync(&entries, 1, None, 1, counter, &mut counts);
    assert_eq!(window.bounded(&entries, 1, 0, true, 0), 1);
    assert!(window
        .scan(&entries, 1, 2, 100, counter, &mut counts)
        .is_none());
}

#[test]
fn bounded_validation_keeps_the_real_final_system_and_non_system_anchors() {
    let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
    for role in [Role::System, Role::User] {
        let system = |n, id| {
            row(
                n,
                Role::System,
                vec![Part::new(
                    id,
                    PartBody::Text {
                        text: "Framing".into(),
                    },
                )],
            )
        };
        let mut entries = if role == Role::System {
            vec![system(1, "old"), system(2, "current")]
        } else {
            vec![
                text(1, "Old request"),
                text(2, "Current request"),
                system(3, "tail"),
            ]
        };
        entries.push(row(
            entries.len() as u64 + 1,
            Role::Assistant,
            vec![omit(line("lost", 0, "Cut reply"))],
        ));
        on_both(&entries, |entries| {
            crate::view_builder::next_view(
                None,
                entries,
                vec![EditOp::Drop {
                    mid: entries[0].mid.clone(),
                    part: None,
                }],
                &rules,
                1,
                |_| false,
            )
            .unwrap()
            .unwrap()
        });
    }
}

#[test]
fn an_omitted_tail_cannot_make_the_history_cut_pass_its_last_anchor() {
    for show_system in [false, true] {
        let parts = || {
            show_system
                .then(|| {
                    Part::new(
                        "system",
                        PartBody::Text {
                            text: "Framing".into(),
                        },
                    )
                })
                .into_iter()
                .collect()
        };
        let entries = [
            row(1, Role::System, parts()),
            row(2, Role::System, parts()),
            row(3, Role::Assistant, vec![omit(line("lost", 0, "Cut reply"))]),
        ];
        let cut = |entries: &[Entry]| {
            let (mut session, _, _, _, mut settings) = fixture();
            session.features.summarizer = true;
            settings.memory_enabled = false;
            session.index.extend(entries.iter().cloned());
            session.numbers_covered = Some(MoveFloor {
                ordinal: 2,
                mid: "m2".into(),
            });
            session.history_ops(&settings, false).1
        };
        assert_eq!(cut(&entries), Some(1));
        on_both(&entries, cut);
    }
}

#[test]
fn a_fake_tag_on_omitted_text_does_not_shift_an_answered_images_age() {
    let mut invalid = omit(line("lost", 0, "Cut reply"));
    invalid.tag = Some(999);
    let entries = [
        row(
            1,
            Role::User,
            vec![
                line("question", 1, "What is this?"),
                Part::new(
                    "image",
                    PartBody::File(FileMedia::inline("image/png", Some(300))),
                ),
                invalid,
            ],
        ),
        row(
            2,
            Role::Assistant,
            vec![line("answer", 2, "It is a diagram.")],
        ),
    ];
    on_both(&entries, |entries| {
        select(entries, |context| {
            let result = lanes::answered_images(
                context,
                &lanes::Images {
                    outputs: &BTreeMap::new(),
                    watermark: 2,
                    cutoff: None,
                    over_limit: false,
                    skip: &[],
                },
            );
            assert_eq!(result.1, [("m1".into(), "image".into())]);
            result
        })
    });
}

#[test]
fn an_omitted_frame_cannot_turn_visible_words_into_a_relayed_wake() {
    let entry = row(
        1,
        Role::User,
        vec![
            omit(line("start", 0, "<system-reminder>\nInbox:")),
            line("ordinary", 1, "Use the new version.\n</system-reminder>"),
        ],
    );
    assert!(crate::summary::trigger::is_meaningful_user(&entry));
}

#[test]
fn an_omitted_tail_does_not_make_the_newest_oversized_entry_summarizable() {
    use cortexkit_role_compaction::tokens::PartTokens;
    let mut huge = line("huge", 2, "Newest model answer.");
    huge.tokens = Some(PartTokens::count(80_000));
    let mut older = line("older", 1, "Older words.");
    older.tokens = Some(PartTokens::count(30_000));
    let entries = [
        row(1, Role::Assistant, vec![older]),
        row(2, Role::Assistant, vec![huge]),
        row(
            3,
            Role::Assistant,
            vec![omit(line("lost", 0, "Unsent remainder"))],
        ),
    ];
    on_both(&entries, |entries| {
        let mut window = Window::default();
        let counter = crate::count::Counter::for_model(None);
        let mut counts = chunk::CountCache::default();
        window.sync(entries, 1, None, 1, counter, &mut counts);
        let until = window.bounded(entries, 1, 100, true, u64::MAX);
        assert_eq!(until, 2);
        until
    });
}

#[test]
fn omitted_signed_reasoning_cannot_keep_a_cleared_step_on_hold() {
    let signed = |id| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(8_000),
            },
        )
        .with_seal(Seal::Signed)
    };
    let entries = [
        text(1, "Question"),
        row(
            2,
            Role::Assistant,
            vec![signed("shown"), omit(signed("not-sent"))],
        ),
    ];
    let (session, _, _, _, _) = fixture();
    let mut conditions = session.conditions;
    conditions.rules.signed_parts = SignedParts::Bound;
    let edited = lanes::Edited::default().including(&[("m2".into(), "shown".into())]);
    on_both(&entries, |entries| {
        let hold =
            crate::pass::heavy_signed_turn_in_view(entries, &conditions, None, Some(&edited));
        assert!(!hold);
        hold
    });
}

#[test]
fn exact_summary_counts_keep_the_same_block_start_and_shape_after_omission() {
    use super::omitted_twin_checks::{framed_text, materialize, Slot};
    let slots = [
        Slot {
            role: Role::User,
            parts: vec![(line("absent", 0, "Never sent"), true)],
            notice: None,
        },
        Slot {
            role: Role::User,
            parts: vec![(line("actual", 0, "Find the test"), false)],
            notice: None,
        },
        Slot {
            role: Role::User,
            parts: vec![
                (framed_text("Never sent either"), true),
                (line("next", 0, "Then check it"), false),
            ],
            notice: None,
        },
        Slot {
            role: Role::Assistant,
            parts: vec![(line("reply", 0, "Ready"), false)],
            notice: None,
        },
    ];
    let (marked, _, twin) = materialize(&slots, false);
    let scan = |entries: &[Entry]| {
        let counter = crate::count::Counter::for_model(Some("anthropic/claude-opus-5-5"));
        assert!(counter.family().is_some());
        let mut window = Window::default();
        let mut counts = chunk::CountCache::default();
        window.sync(entries, 1, None, 1, counter, &mut counts);
        window
            .scan(entries, 1, 5, 500, counter, &mut counts)
            .unwrap()
    };
    assert_eq!(scan(&marked), scan(&twin));
}
