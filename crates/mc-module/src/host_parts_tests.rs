use super::*;
use cortexkit_role_compaction::read::HostPart;

fn marked(mut entry: Entry) -> Entry {
    entry.host_parts = entry.parts.iter().map(|p| HostPart::new(&p.id)).collect();
    entry
}

#[test]
fn host_parts_do_not_become_the_prompt_or_floor_mark() {
    let (_, _, route, mut setup, settings) = fixture();
    setup.preset = "head".into();
    let mut session = Session::new(
        &route,
        &setup,
        crate::preset::features("head").unwrap(),
        None,
    );
    session
        .index
        .extend(vec![text(1, "real prompt"), marked(text(2, "Continue…"))]);
    session.floor_pending_for = Some((2, "Continue…".into()));
    session.conditions.last_prompt_tokens = Some(65_000);
    session.reading_stale = true;
    let _ = crate::test_log::logged(|| session.summary_due(&settings));
    assert!(
        session.floor_pending_for.is_none(),
        "a host row cannot retain a prompt floor"
    );
    assert!(!trigger::is_meaningful_user(&session.index.entries()[1]));
    assert!(!lanes::starts_user_turn(&session.index.entries()[1]));
    let mut entries = session.index.entries().to_vec();
    let mut answer = text(3, "answer");
    answer.role = Role::Assistant;
    entries.push(answer);
    assert_eq!(trigger::tail_start(&entries, |_| 1_000, 1, 100, false), 1);
}

#[tokio::test]
async fn host_parts_session_reminder_counts_only_actionable_turns() {
    let (mut session, client, _, _, settings) = fixture();
    let mut prompt = text(1, "prompt");
    prompt.parts[0] = Part::new(
        "p",
        PartBody::Text {
            text: "work ".repeat(80_000).into(),
        },
    );
    prompt.parts[0].tag = Some(1);
    session
        .index
        .extend(vec![prompt, marked(text(2, "Continue…"))]);
    session.remind(&client, &settings, false, false).await;
    assert_eq!(session.nudges.last_fire_turn, Some(1));
}

#[tokio::test]
async fn host_parts_recovery_preserves_bytes_and_labels_full_tag_preview_and_range() {
    let (session, client, _, _, _) = fixture();
    let mut entry = text(1, "stored bytes\nwith line break");
    entry.host_parts = vec![HostPart::new("p").with_host_code("continue")];
    *client.entries.lock().unwrap() = vec![entry.clone()];
    for input in [
        serde_json::json!({"message":1}),
        serde_json::json!({"tag":1}),
        serde_json::json!({"start":1,"end":1,"verbose":true}),
        serde_json::json!({"start":1,"end":1}),
    ] {
        if input.get("tag").is_some() {
            client
                .pages
                .lock()
                .unwrap()
                .push_back(Ok(ReadPage::new(vec![entry.clone()], Head::new())));
        }
        let out = crate::expand::run(
            &client,
            &session.key,
            session.limits,
            &input,
            Some(1),
            crate::count::Counter::for_model(None),
        )
        .await
        .unwrap();
        assert!(out.contains("[host text: continue]"), "{input}: {out}");
        assert!(
            out.contains("stored bytes\nwith line break"),
            "{input}: {out}"
        );
        assert!(!out.contains("U (user)"), "{out}");
    }
}

#[test]
fn host_parts_app_attribution_backfills_without_changing_total_tokens() {
    let (mut session, _, _, _, _) = fixture();
    let entry = text(1, "host words");
    session.index.extend(vec![entry.clone()]);
    let before = session.app_snapshot();
    let mut entry = marked(entry);
    entry.host_parts[0] = HostPart::new("p").with_host_code("continue");
    session.index.extend(vec![entry]);
    let after = session.app_snapshot();
    let row = &after.messages["host words"].row;
    assert_eq!(
        row["host_parts"],
        serde_json::json!([{"part":"p","host_code":"continue"}])
    );
    assert_eq!(
        row["items"][0]["origin"],
        serde_json::json!({"kind":"host","label":"[host text: continue]","host_code":"continue"})
    );
    assert_eq!(before.breakdown["total"], after.breakdown["total"]);
}

#[tokio::test]
async fn host_parts_backfill_never_restores_an_aged_placeholder() {
    let (mut session, client, _, _, settings) = fixture();
    two_old_outputs(&mut session);
    let (view, _) = session.build(&settings, None, false, None);
    session
        .publish(&client, view.expect("age sweep offered drops"))
        .await;
    let old_edits: Vec<_> = session.latest.as_ref().unwrap().edits.iter().filter(|edit| {
        matches!(&edit.op, EditOp::Replace { mid, .. } | EditOp::Drop { mid, .. } if mid == "old")
    }).cloned().collect();
    assert!(!old_edits.is_empty());
    assert!(old_edits.iter().any(|edit| {
        matches!(&edit.op, EditOp::Replace { value, .. } if value.as_str().is_some_and(|text| text.contains("[dropped ")))
    }), "the accepted age sweep must include a placeholder");
    let retry = marked(session.index.at(3).unwrap().clone());
    session.index.extend(vec![retry]);
    let (view, _) = session.build(&settings, None, false, None);
    if let Some(view) = view {
        session.publish(&client, view).await;
    }
    for edit in old_edits {
        assert!(
            session.latest.as_ref().unwrap().edits.contains(&edit),
            "aged output was restored"
        );
    }
}

#[test]
fn host_parts_are_not_turns_or_reminder_mass() {
    let (mut session, _, _, _, _) = fixture();
    session
        .index
        .extend(vec![text(1, "real prompt"), marked(text(2, "Continue…"))]);
    assert_eq!(crate::nudges::person_turns(session.index.entries()), 1);
    let edited = lanes::Edited::of(None, &session.index, None);
    let protected_tools = std::collections::BTreeMap::new();
    let context = lanes::Context {
        index: &session.index,
        edited: &edited,
        protected_tools: &protected_tools,
        keep_first_message: false,
        signed_floor: None,
    };
    let measurement = crate::nudges::measure(&context, None, &Default::default());
    assert_eq!(
        measurement.t,
        crate::tokens::part(&session.index.entries()[0].parts[0])
    );
}

#[test]
fn host_parts_are_omitted_from_summary_lines_for_both_roles() {
    for role in [Role::User, Role::Assistant] {
        let mut entry = text(1, "real words");
        entry.role = role;
        entry.parts.push(Part::new(
            "host",
            PartBody::Text {
                text: "HOST SECRET Committed deadbee".into(),
            },
        ));
        entry.host_parts = vec![HostPart::new("host")];
        let chunk = crate::summary::chunk::build(
            &[entry.clone()],
            10_000,
            crate::count::Counter::for_model(None),
        )
        .unwrap();
        assert!(chunk.input.contains("real words"));
        assert!(!chunk.input.contains("HOST SECRET"), "{}", chunk.input);
        assert!(
            !crate::summary::hashes::by_ordinal(std::slice::from_ref(&entry))[&1]
                .contains("deadbee")
        );
        entry.host_parts.insert(0, HostPart::new("p"));
        assert!(crate::summary::chunk::build(
            &[entry],
            10_000,
            crate::count::Counter::for_model(None)
        )
        .is_none());
    }
}

#[test]
fn host_parts_do_not_reach_the_due_checks_message_threshold() {
    let (_, _, route, mut setup, settings) = fixture();
    setup.preset = "head".into();
    for legacy in [false, true] {
        let mut session = Session::new(
            &route,
            &setup,
            crate::preset::features("head").unwrap(),
            None,
        );
        session.use_legacy_summary_scan(legacy);
        let mut entries = vec![text(1, "real prompt")];
        entries.extend((2..=13).map(|i| marked(text(i, &format!("Continue {i}")))));
        let mut output = cortexkit_role_compaction::part::ToolPart::new(
            "c",
            "read",
            serde_json::json!({"path":"src/main.rs"}),
            cortexkit_role_compaction::part::ToolStatus::Completed,
        );
        output.output_bytes = Some(400_000);
        entries.push(Entry::new(
            14,
            "tail",
            Role::Assistant,
            14,
            vec![Part::new("t", PartBody::Tool(output))],
        ));
        let chunk = crate::summary::chunk::build(
            &entries[..13],
            10_000,
            crate::count::Counter::for_model(None),
        )
        .unwrap();
        assert_eq!(chunk.messages, 1);
        session.index.extend(entries);
        session.conditions.last_prompt_tokens = Some(65_000);
        session.floor_pending_for = Some((1, "real prompt".into()));
        let (request, _) = crate::test_log::logged(|| session.summary_due(&settings));
        assert!(
            request.is_none(),
            "host-only rows met the proactive message threshold (legacy={legacy})"
        );
    }
}

#[test]
fn host_parts_vectors_decode_marked_and_legacy_without_digest_changes() {
    use sha2::{Digest, Sha256};
    let samples = [
        (
            include_bytes!("../testdata/entries-host-parts.json").as_slice(),
            "1f83c39f630bcb2ad0419e855e8bb5de6e2f1f87cdc9a4d0267ce743f7ca7902",
        ),
        (
            include_bytes!("../testdata/entries-host-parts-legacy.json").as_slice(),
            "ec91ee94f5d332fafd016b8769d5d55e6caca69b3099d88608f59abe70ccc7fe",
        ),
    ];
    let pages: Vec<ReadPage> = samples
        .iter()
        .map(|(bytes, hash)| {
            assert_eq!(format!("{:x}", Sha256::digest(bytes)), *hash);
            serde_json::from_slice(bytes).unwrap()
        })
        .collect();
    assert!(pages[0].entries.iter().any(|e| !e.host_parts.is_empty()));
    assert!(pages[1].entries.iter().all(|e| e.host_parts.is_empty()));
    for (marked, legacy) in pages[0].entries.iter().zip(&pages[1].entries) {
        assert_eq!(marked.parts, legacy.parts);
        assert_eq!(marked.digest, legacy.digest);
    }
}
