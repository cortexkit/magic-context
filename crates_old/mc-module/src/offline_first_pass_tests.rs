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
        0,
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
fn moved_pages_start_at_the_message_checkpoint_not_zero() {
    let codec = crate::providers::codec::Codec::OpencodeAiSdk;
    let pages = parse_pages(
        (page(17..20, Some(20)) + "\n" + &page(20..22, None)).as_bytes(),
        codec,
        17,
    )
    .unwrap();
    assert_eq!(pages.entries, 5);
    assert_eq!(pages.served[0].first, 17);
    assert_eq!(pages.served[1].last, 21);
    for range in [0..5, 18..22] {
        assert_eq!(
            parse_pages(page(range, None).as_bytes(), codec, 17)
                .err()
                .unwrap()
                .code,
            "pages_not_chained"
        );
    }
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
fn rich_ui_stamp_offline_import_parser() {
    for name in ["session.read.default.json", "session.read.opt-in.json"] {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("testdata/broca-rich-ui-stamp")
                .join(name),
        )
        .unwrap();
        let mut page =
            crate::session_resolver::read_runner_reply(serde_json::from_slice(&bytes).unwrap())
                .unwrap();
        let codec = crate::providers::codec::Codec::OwnedBroca;
        // The CLI requires bare descriptor pages. The captured inline page
        // must still reach the existing missing-digest refusal, not a new one.
        let error = parse_pages(page.to_string().as_bytes(), codec, 0)
            .err()
            .unwrap();
        assert_eq!(error.code, "served_digest_missing", "{name}");
        eprintln!("{name}: inline offline import: {error:?}");
        for row in page["messages"].as_array_mut().unwrap() {
            let entry: ReadMessage = serde_json::from_value(row.clone()).unwrap();
            let served = serde_json::to_value(serve_descriptors(&entry)).unwrap();
            for key in ["digest", "part_digests"] {
                row[key] = served[key].clone();
            }
        }
        let pages = parse_pages(page.to_string().as_bytes(), codec, 0).unwrap();
        assert_eq!(pages.entries, 2, "{name}");
    }
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

/// An export written before the live Setup can't know its `request_id` or
/// `now`, and the Setup identity digest ignores both, so a request without
/// them reads as the same Setup as one that carries them.
#[test]
fn a_setup_export_without_request_id_or_now_reads_as_the_same_setup() {
    let dir = tempfile::tempdir().unwrap();
    let request = json!({
        "session": "ses_export",
        "harness": "opencode",
        "lineage_id": "lin_export",
        "params": {},
        "composition": {"prefrontal": "x"},
        "model": "anthropic/claude-opus-5-5",
        "context_window": 1_000_000,
    });
    let write = |name: &str, request: Value| {
        let path = dir.path().join(name);
        std::fs::write(
            &path,
            json!({
                "project_root": "/repo",
                "runner_module": "thalamus-harness",
                // A real thalamus-harness describe, captured from a live export.
                "runner_describe": serde_json::from_str::<Value>(include_str!(
                    "../testdata/offline-first-pass/thalamus-runner-describe.json"
                ))
                .unwrap(),
                "request": request,
            })
            .to_string(),
        )
        .unwrap();
        path
    };
    let bare = read_setup(&write("bare.json", request.clone()), "ses_export");
    let mut full = request;
    full["request_id"] = json!("live-request-7");
    full["now"] = json!(1_790_000_000_000u64);
    let full = read_setup(&write("full.json", full), "ses_export");
    let (bare, full) = match (bare, full) {
        (Ok(bare), Ok(full)) => (bare, full),
        (bare, full) => panic!("bare: {:?}, full: {:?}", bare.err(), full.err()),
    };
    assert_eq!(full.request.request_id, "live-request-7");
    // The identity digest drops exactly these two fields, so removing them
    // from both requests must leave the same JSON.
    let identity = |request: &SetupRequest| {
        let mut value = serde_json::to_value(request).unwrap();
        let fields = value.as_object_mut().unwrap();
        fields.remove("request_id");
        fields.remove("now");
        value
    };
    assert_eq!(identity(&bare.request), identity(&full.request));
}
