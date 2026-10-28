//! The page parser of `ck-mc offline first-pass`. The command's runs, its
//! refusals on real moved stores and the live adoption are tested in
//! `providers::async_provider::tests::offline_first_pass`.
use super::*;
use crate::providers::serve_descriptors;
use cortexkit_role_llm_runner::read::ReadMessage;

/// A page of `ordinals` as a descriptors-mode read serves it, with the
/// runner's digests on every message.
fn page(ordinals: std::ops::Range<u64>, next: Option<u64>) -> String {
    let messages = ordinals
        .map(|n| {
            ReadMessage::new(
                n,
                format!("m{n}"),
                json!({"parts":[{"type":"text","text":"x"}]}),
            )
            .with_tags(vec![tags::PartTag::tagged(
                format!("p{n}"),
                format!("§{}§", 21 + n),
            )])
        })
        .map(|message| serve_descriptors(&message))
        .collect::<Vec<_>>();
    let page = ReadPage::new("L", messages);
    let page = match next {
        Some(next) => page.with_next_from_ordinal(next),
        None => page,
    };
    serde_json::to_string(&page).unwrap()
}

fn parse(lines: &[String]) -> Result<Pages, Refusal> {
    parse_pages(
        (lines.join("\n") + "\n").as_bytes(),
        crate::providers::codec::Codec::OpencodeAiSdk,
    )
}

fn code(lines: &[String]) -> &'static str {
    parse(lines).err().expect("a refusal").code
}

#[test]
fn chained_bare_pages_parse_with_their_lowest_tag() {
    let pages = parse(&[page(0..3, Some(3)), page(3..5, Some(5)), page(5..6, None)]).unwrap();
    assert_eq!(pages.entries, 6);
    assert_eq!(pages.lineage, "L");
    assert_eq!(pages.lowest_tag, Some(21));
    assert_eq!(
        pages
            .served
            .iter()
            .map(|page| (page.first, page.last))
            .collect::<Vec<_>>(),
        vec![(0, 2), (3, 4), (5, 5)]
    );
}

#[test]
fn pages_that_do_not_chain_from_ordinal_zero_are_refused() {
    for (case, lines) in [
        ("starts at 1", vec![page(1..3, None)]),
        ("gap", vec![page(0..2, Some(2)), page(3..4, None)]),
        (
            "next names a gap",
            vec![page(0..2, Some(3)), page(3..4, None)],
        ),
        ("last page names a next", vec![page(0..2, Some(2))]),
        (
            "page after the last",
            vec![page(0..2, None), page(2..3, None)],
        ),
        ("empty page", vec![page(0..0, None)]),
        (
            "lineage changes",
            vec![
                page(0..2, Some(2)),
                page(2..3, None).replace("\"lineage_id\":\"L\"", "\"lineage_id\":\"L2\""),
            ],
        ),
    ] {
        assert_eq!(code(&lines), "pages_not_chained", "{case}");
    }
    assert_eq!(code(&[]), "pages_not_chained", "no page");
}

#[test]
fn a_wrapped_page_is_a_bare_wrapped_mismatch() {
    let bare = page(0..2, Some(2));
    let wrapped =
        json!({"result": serde_json::from_str::<Value>(&page(2..3, None)).unwrap()}).to_string();
    assert_eq!(
        code(&[bare.clone(), wrapped]),
        "pages_bare_wrapped_mismatch"
    );
    assert_eq!(code(&["[1]".into()]), "pages_bare_wrapped_mismatch");
    assert_eq!(code(&["{\"page\":1}".into()]), "pages_unreadable");
    assert_eq!(
        code(&[bare, String::new(), page(2..3, None)]),
        "pages_unreadable"
    );
}

#[test]
fn a_message_without_the_runners_digests_is_refused_by_name() {
    let served = page(0..2, None);
    for member in ["digest", "part_digests"] {
        let mut value: Value = serde_json::from_str(&served).unwrap();
        value["messages"][1].as_object_mut().unwrap().remove(member);
        assert_eq!(
            code(&[value.to_string()]),
            "served_digest_missing",
            "{member}"
        );
    }
    // A part_digests row keyed to another part than the tag rows.
    let mut value: Value = serde_json::from_str(&served).unwrap();
    value["messages"][0]["part_digests"][0]["part"] = json!("other");
    assert_eq!(code(&[value.to_string()]), "served_digest_missing");
    assert!(parse(&[served]).is_ok());
}

#[test]
fn the_checkpoint_is_the_number_below_the_lowest_tag() {
    let pages = parse(&[page(0..2, None)]).unwrap();
    let record = |checkpoint| MoveRecord {
        version: crate::offline_move::RECORD_VERSION,
        session: "s".into(),
        harness: "opencode".into(),
        tag_checkpoint: checkpoint,
        cut: "m0".into(),
        marker_part: "p".into(),
        codec_profile: Default::default(),
        compartments: Vec::new(),
        drops: Vec::new(),
        ..Default::default()
    };
    assert!(check_checkpoint(&record(20), &pages).is_ok());
    assert_eq!(
        check_checkpoint(&record(19), &pages).unwrap_err().code,
        "checkpoint_mismatch"
    );
    assert_eq!(
        check_checkpoint(&record(21), &pages).unwrap_err().code,
        "checkpoint_mismatch"
    );
}
