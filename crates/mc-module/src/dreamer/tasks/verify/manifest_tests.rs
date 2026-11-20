use super::*;

fn verdict(id: i64, decision: Decision) -> Verdict {
    Verdict {
        id,
        decision,
        files: Vec::new(),
        content: String::new(),
        reason: String::new(),
        consolidation: false,
        missing: None,
        cites: None,
        derive: None,
    }
}

#[test]
fn a_manifest_gives_each_memory_one_verdict_with_its_fields() {
    let reply = r#"Some words first.
<verify>
<verified id="1" files="src/a.rs, src/b.rs ,"/>
<update id="2" files="src/c.rs">  The handler takes two arguments.  </update>
<update id="3" consolidation="TRUE">Short.</update>
<archive id="4" reason="the module was removed" missing=" src/old/module.rs "/>
<archive id="5" reason="contradicted by src/x.rs"/>
<skip id="6" reason="behavioural directive"/>
</verify>"#;
    let verdicts = parse_manifest(reply, &[1, 2, 3, 4, 5, 6]).unwrap();
    assert_eq!(
        verdicts,
        [
            Verdict {
                files: vec!["src/a.rs".into(), "src/b.rs".into()],
                ..verdict(1, Decision::Verified)
            },
            Verdict {
                files: vec!["src/c.rs".into()],
                content: "The handler takes two arguments.".into(),
                ..verdict(2, Decision::Update)
            },
            Verdict {
                content: "Short.".into(),
                consolidation: true,
                ..verdict(3, Decision::Update)
            },
            Verdict {
                reason: "the module was removed".into(),
                missing: Some("src/old/module.rs".into()),
                ..verdict(4, Decision::Archive)
            },
            Verdict {
                reason: "contradicted by src/x.rs".into(),
                ..verdict(5, Decision::Archive)
            },
            Verdict {
                reason: "behavioural directive".into(),
                ..verdict(6, Decision::Skip)
            },
        ]
    );
}

#[test]
fn missing_is_read_on_an_archive_or_rewrite_and_blank_is_ignored() {
    let verdicts = parse_manifest(
        r#"<verify><skip id="1" missing="x_name"/><archive id="2" missing="  "/><update id="3" missing=" old_name ">new_name</update></verify>"#,
        &[1, 2, 3],
    )
    .unwrap();
    let read: Vec<_> = verdicts
        .iter()
        .map(|verdict| (verdict.id, verdict.missing.as_deref()))
        .collect();
    assert_eq!(read, [(3, Some("old_name")), (2, None), (1, None)]);
}

#[test]
fn spans_and_arithmetic_are_left_for_verdict_checks() {
    let verdicts = parse_manifest(
        r#"<verify>
<verified id="1" files="src/a.rs" cites="src/a.rs:120-128;src/b.rs:40-41" derive="150 s = 10 × 15_000 ms"/>
<verified id="2" files="src/a.rs" cites="not a span"/>
<verified id="3" files="src/a.rs"/>
<update id="5" cites="src/a.rs:1" derive="2 = 1 + 1">new content</update>
<archive id="6" cites="src/a.rs:2" derive="1 = 1"/>
<skip id="4" cites="src/a.rs:1-2" derive="1 = 1"/>
</verify>"#,
        &[1, 2, 3, 4, 5, 6],
    )
    .unwrap();
    let read: Vec<(Option<&str>, Option<&str>)> = verdicts
        .iter()
        .map(|verdict| (verdict.cites.as_deref(), verdict.derive.as_deref()))
        .collect();
    // A malformed or missing cite is the write's to judge: it counts as a
    // skip there.
    assert_eq!(
        read,
        [
            (
                Some("src/a.rs:120-128;src/b.rs:40-41"),
                Some("150 s = 10 × 15_000 ms")
            ),
            (Some("not a span"), None),
            (None, None),
            (Some("src/a.rs:1"), Some("2 = 1 + 1")),
            (Some("src/a.rs:2"), None),
            (None, None),
        ]
    );
}

#[test]
fn a_manifest_without_its_closing_root_is_refused() {
    // A reply cut off after some verdicts is never read as far as it goes.
    assert_eq!(
        parse_manifest(r#"<verify><verified id="1"/>"#, &[1]),
        Err("verify manifest missing complete root element".into())
    );
    assert_eq!(
        parse_manifest("I checked them all; they hold.", &[1]),
        Err("verify manifest missing complete root element".into())
    );
}

#[test]
fn unknown_ids_are_dropped_and_duplicates_refused() {
    assert_eq!(
        parse_manifest(
            r#"<verify><verified id="9"/><verified id="1"/><skip id="+2abc"/></verify>"#,
            &[1, 2]
        )
        .unwrap()
        .iter()
        .map(|verdict| verdict.id)
        .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(
        parse_manifest(r#"<verify><verified id="1"/><skip id="1"/></verify>"#, &[1]),
        Err("verify manifest contains duplicate id 1".into())
    );
    assert_eq!(
        parse_manifest(r#"<verify><verified id="x"/></verify>"#, &[1]),
        Err("verify manifest entry missing numeric id".into())
    );
}

#[test]
fn a_manifest_must_decide_at_least_half_the_batch() {
    assert_eq!(
        parse_manifest("<verify></verify>", &[1]),
        Err("verify manifest parsed zero entries".into())
    );
    assert_eq!(
        parse_manifest(r#"<verify><verified id="1"/></verify>"#, &[1, 2, 3]),
        Err("verify manifest covers fewer than half the batch ids".into())
    );
    assert_eq!(
        parse_manifest(
            r#"<verify><verified id="1"/><skip id="2"/></verify>"#,
            &[1, 2, 3, 4]
        )
        .unwrap()
        .len(),
        2
    );
}
