use super::*;
use crate::test_log::capture;

#[test]
fn render_failed_published_sample_bodies_decode_in_notice_events() {
    // These are the bodies published in the contract crate's render_failed
    // wire tests. Field detail diagnoses the failing field; the runner skips
    // every replacement of the affected part, not just that field.
    let mut samples = vec![
        serde_json::json!({"code":"render_failed"}),
        serde_json::json!({"code":"render_failed", "mid":"message-a"}),
        serde_json::json!({"code":"render_failed", "mid":"message-a", "part":"part-a"}),
    ];
    for field in ["text", "output", "attachments", "delivered", "input.query"] {
        samples.push(serde_json::json!({"code":"render_failed", "mid":"message-a", "part":"part-a", "field":field}));
    }
    for refusal in samples {
        let body = serde_json::json!({"event":"view_refused", "version":7, "refusal":refusal});
        let decoded: Event = serde_json::from_value(body.clone()).unwrap();
        assert!(matches!(
            &decoded,
            Event::ViewRefused {
                refusal: ViewRefusal::RenderFailed { .. },
                ..
            }
        ));
        assert_eq!(serde_json::to_value(decoded).unwrap(), body);
    }
}

#[test]
fn render_failed_capability_is_declared() {
    let manifest = serde_json::to_value(crate::transport::manifest(crate::MODULE_ID)).unwrap();
    let claims: Vec<String> =
        serde_json::from_value(manifest["capabilities"]["provides"].clone()).unwrap();
    assert!(cortexkit_role_compaction::provides_render_failed(&claims));
    assert!(claims
        .iter()
        .any(|claim| claim == "compaction-render-failed/v1"));
}

fn fixture_with_view() -> (Session, Client, Route, SetupRequest, Settings, View) {
    let (mut session, client, route, request, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        Entry::new(2, "old", Role::Assistant, 2, vec![output_part("p", 2)]),
        text(3, "queued"),
        Entry::new(
            4,
            "newer",
            Role::Assistant,
            4,
            (0..25)
                .map(|n| output_part(&format!("q{n}"), 4 + n))
                .collect(),
        ),
        text(5, "tail"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.conditions.last_prompt_tokens = Some(20_000);
    let view = session.seal_unchecked(vec![
        EditOp::Replace {
            mid: "old".into(),
            part: "p".into(),
            field: "output".into(),
            value: serde_json::json!("trimmed"),
            expect: String::new().into(),
        },
        EditOp::Replace {
            mid: "old".into(),
            part: "p".into(),
            field: "attachments".into(),
            value: serde_json::json!([]),
            expect: String::new().into(),
        },
    ]);
    session.next_covered = vec![("old".into(), "p".into())];
    session.accept(view.clone());
    (session, client, route, request, settings, view)
}

fn failure(
    session: &Session,
    client: &Client,
    seq: u64,
    view: &View,
    body: Value,
) -> NoticeRequest {
    let mut request = notice(
        session,
        seq,
        client.entries.lock().unwrap().last().map(cursor),
    );
    request.applied_view = Some(view.applied());
    request.events.push(Event::ViewRefused {
        version: view.version,
        refusal: serde_json::from_value(body).unwrap(),
    });
    request
}

fn replaces(view: &View, mid: &str, part: &str) -> bool {
    view.edits.iter().any(|e| {
        matches!(&e.op,
        EditOp::Replace { mid: m, part: p, .. } if m == mid && p == part)
    })
}

#[tokio::test]
async fn render_failed_part_keeps_accepted_view_without_penalty_or_immediate_rebuild() {
    for late in [false, true] {
        let logs = capture();
        let (mut session, client, _, _, settings, view) = fixture_with_view();
        if late {
            session.statement_epoch = Some("render-epoch".into());
            session.statement_seq = Some(2);
            session.newest_applied = view.version;
        }
        let body =
            serde_json::json!({"code":"render_failed", "mid":"old", "part":"p", "field":"output"});
        let mut request = failure(&session, &client, 1, &view, body);
        if late {
            request.conditions.statement_seq = Some(1);
        }
        session.notice(&client, &settings, request).await;
        assert_eq!(
            session.latest.as_ref(),
            Some(&view),
            "accepted view was rolled back"
        );
        assert_eq!(session.newest_applied, view.version);
        assert_eq!(session.unconfirmed.is_empty(), !late);
        assert!(
            session.refused_once.is_empty(),
            "render failure incurred a refusal penalty"
        );
        assert!(session.failed_parts.is_empty());
        assert!(
            client.offered.lock().unwrap().is_empty(),
            "part failure alone rebuilt"
        );
        let logs = logs.text();
        assert!(
            logs.contains(
                "session s1: render_failed view 1: mid=\"old\" part=\"p\" field=Some(\"output\")"
            ),
            "{logs}"
        );
        assert_eq!(
            logs.lines()
                .filter(|line| line.contains("WARN") && line.contains("render_failed"))
                .count(),
            1,
            "{logs}"
        );
        assert!(!logs.contains("runner refused view"), "{logs}");
    }
}

#[tokio::test]
async fn render_failed_part_counts_original_and_omits_all_replaces_after_store_reload() {
    let (mut session, client, route, mut setup, settings, view) = fixture_with_view();
    let _ = session.app_snapshot();
    let request = failure(
        &session,
        &client,
        1,
        &view,
        serde_json::json!({"code":"render_failed", "mid":"old", "part":"p", "field":"attachments"}),
    );
    session.notice(&client, &settings, request).await;
    let key = ("old".into(), "p".into());
    let (costs, _) = session.served_costs(view.edits.iter().map(|e| &e.op));
    assert_eq!(
        costs[&key],
        tokens::part(&client.entries.lock().unwrap()[1].parts[0])
    );
    let snapshot = session.app_snapshot();
    let old = snapshot.messages.get("old").expect("old message");
    assert_eq!(
        old.row["items"][0]["tokens"], 10_000,
        "the app must count the stored 40,000-byte output, not the replacement"
    );
    assert_eq!(old.row["items"][0]["state"], "live");

    let dir = tempfile::tempdir().unwrap();
    let store = crate::store::Store::open(&dir.path().join("mode3.db")).unwrap();
    store.save(&route.session, &session.durable()).unwrap();
    let durable = store.load(&route.session).unwrap();
    let mut restored = Session::new(&route, &setup, session.features, None);
    restored.restore(durable);
    *client.applied.lock().unwrap() = Some(
        AppliedViewAnswer::new()
            .with_view(view.clone())
            .with_applied_by(crate::MODULE_ID),
    );
    setup.applied_view = Some(view.applied());
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    restored
        .setup(&client, &settings, &route, &setup, session.features)
        .await;
    assert_eq!(restored.latest.as_ref(), Some(&view));
    let mut permitted = notice(&restored, 1, setup.newest.clone());
    permitted.applied_view = Some(view.applied());
    permitted.conditions.last_prompt_tokens = Some(75_000);
    restored.notice(&client, &settings, permitted).await;
    let repaired = restored.latest.clone().unwrap();
    assert!(repaired.version > view.version);
    assert!(
        !replaces(&repaired, "old", "p"),
        "a field replacement survived reload"
    );
    // The render skip is not a drop ban. An old call may still be removed
    // whole once the model asks on a later permitted rebuild.
    restored.queued.insert(key);
    let mut permitted = notice(&restored, 2, setup.newest);
    permitted.applied_view = Some(repaired.applied());
    permitted.conditions.last_prompt_tokens = Some(76_000);
    restored.notice(&client, &settings, permitted).await;
    assert!(restored.latest.as_ref().unwrap().edits.iter().any(
        |e| matches!(&e.op, EditOp::Drop { mid, part: Some(part) } if mid == "old" && part == "p")
    ));
}

#[tokio::test]
async fn render_failed_no_view_rereads_and_rebuilds_once_then_waits_for_permission() {
    for mid in [None, Some("old")] {
        let logs = capture();
        let (mut session, client, route, mut setup, settings, view) = fixture_with_view();
        session.queued.insert(("queued".into(), "p".into()));
        // A notice delta need not contain the older message whose coverage
        // changed; the fallback must fetch it from the authoritative runner.
        client.entries.lock().unwrap()[2] = text(3, "changed");
        session.queued.insert(("changed".into(), "p".into()));
        let body = mid.map_or(
            serde_json::json!({"code":"render_failed"}),
            |mid| serde_json::json!({"code":"render_failed", "mid":mid}),
        );
        let mut request = failure(&session, &client, 1, &view, body.clone());
        request.entries = vec![client.entries.lock().unwrap().last().unwrap().clone()];
        session.notice(&client, &settings, request).await;
        assert!(
            !client.reads.lock().unwrap().is_empty(),
            "no-view fallback did not reread"
        );
        assert_eq!(session.index.entries()[2].mid, "changed");
        let repaired = session.latest.clone().expect("recovery view");
        assert_eq!(repaired.version, view.version + 1, "no immediate recovery");
        assert!(
            repaired
                .edits
                .iter()
                .any(|e| matches!(&e.op, EditOp::Replace { mid, .. } if mid == "changed")),
            "queued work did not drain"
        );
        if mid.is_some() {
            assert!(!replaces(&repaired, "old", "p"));
            assert!(!repaired
                .edits
                .iter()
                .any(|e| matches!(&e.op, EditOp::Drop { mid, .. } if mid == "old")));
        }
        assert!(session.refused_once.is_empty());
        // The retry guard is saved with the session, not just held in memory.
        let durable =
            serde_json::from_value(serde_json::to_value(session.durable()).unwrap()).unwrap();
        session.restore(durable);
        *client.applied.lock().unwrap() = Some(
            AppliedViewAnswer::new()
                .with_view(repaired.clone())
                .with_applied_by(crate::MODULE_ID),
        );
        setup.applied_view = Some(repaired.applied());
        setup.newest = client.entries.lock().unwrap().last().map(cursor);
        session
            .setup(
                &client,
                &settings,
                &route,
                &setup,
                Features {
                    ctx_keep: true,
                    ..Features::NONE
                },
            )
            .await;
        let offers_before = client.offered.lock().unwrap().len();
        let request = failure(&session, &client, 2, &repaired, body);
        session.notice(&client, &settings, request).await;
        assert_eq!(
            session.latest.as_ref(),
            Some(&repaired),
            "repeat rebuilt immediately"
        );
        assert_eq!(client.offered.lock().unwrap().len(), offers_before);
        let logs = logs.text();
        assert!(
            logs.contains("repeat of immediate recovery; waiting for the next permitted rebuild"),
            "{logs}"
        );
        if mid.is_some() {
            assert!(logs.contains("after cut"), "{logs}");
        }
        session.queued.insert(("old".into(), "p".into()));
        let mut permitted = notice(
            &session,
            3,
            client.entries.lock().unwrap().last().map(cursor),
        );
        permitted.applied_view = Some(repaired.applied());
        permitted.conditions.last_prompt_tokens = Some(75_000);
        session.notice(&client, &settings, permitted).await;
        assert!(
            session.latest.as_ref().unwrap().version > repaired.version,
            "natural rebuild stayed blocked"
        );
    }
}

#[tokio::test]
async fn render_failed_no_view_rebuilds_even_when_the_edits_are_identical() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "task"), text(2, "tail")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    let view = session.seal_unchecked(Vec::new());
    session.accept(view.clone());
    let request = failure(
        &session,
        &client,
        1,
        &view,
        serde_json::json!({"code":"render_failed"}),
    );
    session.notice(&client, &settings, request).await;
    let repaired = session.latest.as_ref().unwrap();
    assert_eq!(repaired.version, view.version + 1);
    assert_eq!(repaired.edits, view.edits);
    assert!(session.refused_once.is_empty());
}

fn signed_message_fixture(failed_drop: bool) -> (Session, Client, Settings, View) {
    let (mut session, client, _, _, settings) = fixture();
    session.conditions.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    session.conditions.last_prompt_tokens = Some(20_000);
    let reasoning = Part::new(
        "r",
        PartBody::Reasoning {
            text: Some("stored signed reasoning".into()),
            text_bytes: Some(23),
        },
    )
    .with_seal(cortexkit_role_compaction::part::Seal::Signed);
    let entries = vec![
        text(1, "task"),
        Entry::new(
            2,
            "old",
            Role::Assistant,
            2,
            vec![reasoning, output_part("p", 2)],
        ),
        text(3, "tail"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    let mut ops = vec![EditOp::Replace {
        mid: "old".into(),
        part: "p".into(),
        field: "output".into(),
        value: serde_json::json!("trimmed"),
        expect: "".into(),
    }];
    if failed_drop {
        ops.push(EditOp::Drop {
            mid: "old".into(),
            part: Some("r".into()),
        });
    }
    let view = session.seal_unchecked(ops);
    session.accept(view.clone());
    session.queued.insert(("task".into(), "p".into()));
    (session, client, settings, view)
}

fn reasoning_dropped(view: &View) -> bool {
    view.edits.iter().any(|e| {
        matches!(&e.op,
        EditOp::Drop { mid, part: Some(part) } if mid == "old" && part == "r")
    })
}

#[tokio::test]
async fn render_failed_mid_allows_a_new_provider_rule_companion_reasoning_drop() {
    let (mut session, client, settings, view) = signed_message_fixture(false);
    let request = failure(
        &session,
        &client,
        1,
        &view,
        serde_json::json!({"code":"render_failed", "mid":"old"}),
    );
    session.notice(&client, &settings, request).await;
    let repaired = session.latest.as_ref().unwrap();
    assert_eq!(repaired.version, view.version + 1);
    assert!(
        reasoning_dropped(repaired),
        "changed prefix retained signed reasoning"
    );
    assert!(
        !replaces(repaired, "old", "p"),
        "retried the failing tool edit"
    );
    assert!(
        repaired.edits.iter().any(|e| matches!(&e.op,
        EditOp::Replace { mid, .. } if mid == "task")),
        "queued prefix edit did not drain"
    );
}

#[tokio::test]
async fn render_failed_mid_holds_a_candidate_repeating_the_failed_reasoning_drop() {
    let logs = capture();
    let (mut session, client, settings, view) = signed_message_fixture(true);
    let request = failure(
        &session,
        &client,
        1,
        &view,
        serde_json::json!({"code":"render_failed", "mid":"old"}),
    );
    session.notice(&client, &settings, request).await;
    assert_eq!(session.latest.as_ref(), Some(&view));
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "retried a reasoning drop that already failed"
    );
    assert!(session.queued.contains(&("task".into(), "p".into())));
    assert!(session.refused_once.is_empty());
    assert!(logs
        .text()
        .contains("signed reasoning drop mid=\"old\" part=\"r\" already failed to render"));
    let mut next = notice(
        &session,
        2,
        client.entries.lock().unwrap().last().map(cursor),
    );
    next.applied_view = Some(view.applied());
    session.notice(&client, &settings, next).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "held candidate created an immediate retry loop"
    );
}
