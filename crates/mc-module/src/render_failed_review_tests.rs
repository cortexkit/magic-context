//! Review tests for ck-mc's handling of the runner's `render_failed` report
//! (rules W6.5 and W6.6a in cortexkit-role-compaction's CONTRACT.md: the
//! refusal's shapes, and the runner's fallback after a host rendering
//! failure). Each test names an input where what ck-mc believes the runner
//! serves, or what it publishes next, departs from what the contract and the
//! intended recovery say. They fail until the
//! behaviour they describe is fixed.

use super::*;
use serde_json::json;

/// A session holding view 1: one output replace of `old`/`p`, under a low
/// reading.
fn fixture_with_view() -> (Session, Client, Settings, View) {
    let (mut session, client, _, _, settings) = fixture();
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
    let view = session.seal_unchecked(vec![EditOp::Replace {
        mid: "old".into(),
        part: "p".into(),
        field: "output".into(),
        value: json!("trimmed"),
        expect: String::new().into(),
    }]);
    session.accept(view.clone());
    (session, client, settings, view)
}

fn newest(client: &Client) -> Option<Cursor> {
    client.entries.lock().unwrap().last().map(cursor)
}

/// A notice in which the runner applies `applied`.
fn applying(session: &Session, client: &Client, seq: u64, applied: &View) -> NoticeRequest {
    let mut request = notice(session, seq, newest(client));
    request.applied_view = Some(applied.applied());
    request
}

/// A notice reporting that the runner could not render `view`, which it
/// still applies (W6.6a keeps the accepted view and version).
fn failure(
    session: &Session,
    client: &Client,
    seq: u64,
    view: &View,
    body: Value,
) -> NoticeRequest {
    let mut request = applying(session, client, seq, view);
    request.events.push(Event::ViewRefused {
        version: view.version,
        refusal: serde_json::from_value(body).unwrap(),
    });
    request
}

fn offered(client: &Client) -> Vec<View> {
    client.offered.lock().unwrap().clone()
}

/// An unlocated failure gives ck-mc nothing to exclude, so every view it
/// builds afterwards carries the same edits and fails the same way. After the
/// immediate recovery fails, ck-mc should wait for a rebuild that has
/// something new to land. Instead `ViewPolicy::force` is set on every build
/// while the runner serves no view, so each permitted rebuild republishes the
/// identical edits, and since `accepted` clears `retry_version` for such a
/// rebuild, each failure of it earns another immediate recovery too. The raw
/// history the runner serves keeps every reading at the execute threshold,
/// so every fresh reading permits a rebuild: two failing views per reading,
/// without end.
#[tokio::test]
async fn render_failed_review_unlocated_repeat_does_not_republish_identical_edits() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "task"), text(2, "tail")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    let view = session.seal_unchecked(Vec::new());
    session.accept(view.clone());
    let unlocated = json!({"code":"render_failed"});

    let request = failure(&session, &client, 1, &view, unlocated.clone());
    session.notice(&client, &settings, request).await;
    let repaired = session.latest.clone().expect("immediate recovery");
    assert_eq!(repaired.version, view.version + 1, "no immediate recovery");

    let request = failure(&session, &client, 2, &repaired, unlocated.clone());
    session.notice(&client, &settings, request).await;
    assert_eq!(
        session.latest.as_ref(),
        Some(&repaired),
        "the repeat rebuilt at once"
    );
    let after_repeat = offered(&client).len();

    // The host keeps failing every view with these edits, and the raw history
    // it serves keeps each new reading over the execute threshold.
    let mut reported = repaired.version;
    for seq in 3..9 {
        let latest = session.latest.clone().unwrap();
        let mut request = if latest.version > reported {
            reported = latest.version;
            failure(&session, &client, seq, &latest, unlocated.clone())
        } else {
            applying(&session, &client, seq, &latest)
        };
        request.conditions.last_prompt_tokens = Some(75_000 + seq * 100);
        session.notice(&client, &settings, request).await;
    }
    let republished: Vec<u64> = offered(&client)[after_repeat..]
        .iter()
        .filter(|view| view.edits == repaired.edits)
        .map(|view| view.version)
        .collect();
    assert!(
        republished.is_empty(),
        "published views {republished:?} with the edits the runner already failed to render twice"
    );
}

/// The immediate recovery is cleared in `State::accepted`, which runs when
/// ck-mc records the view, before the runner answers. When the handover then
/// fails (a dropped connection here), the view is rolled back and the runner
/// still serves no view, but the recovery is spent: nothing more is built
/// until a reading reaches the execute threshold. The runner never saw the
/// recovery, so it has not failed; it should be offered again on the next
/// notice.
#[tokio::test]
async fn render_failed_review_recovery_lost_in_handover_is_tried_again() {
    let (mut session, client, settings, view) = fixture_with_view();
    *client.fail_apply.lock().unwrap() = true;
    let request = failure(
        &session,
        &client,
        1,
        &view,
        json!({"code":"render_failed", "mid":"old"}),
    );
    session.notice(&client, &settings, request).await;
    assert_eq!(offered(&client).len(), 1, "no recovery was attempted");
    assert_eq!(session.latest.as_ref(), Some(&view), "not rolled back");
    assert!(
        session.serves_no_view(session.latest.as_ref()),
        "ck-mc forgot the runner serves no view"
    );

    *client.fail_apply.lock().unwrap() = false;
    let request = applying(&session, &client, 2, &view);
    session.notice(&client, &settings, request).await;
    assert_eq!(
        offered(&client).len(),
        2,
        "the recovery that never reached the runner was not offered again; \
         the runner keeps serving raw history"
    );
}

/// A runner whose state went back applies an older view than ck-mc's latest
/// and reports that it cannot render it. `take_render_failures` compares the
/// report with `latest` before `adopt_runner_view` replaces `latest` with the
/// runner's view, so the no-view decision is never recorded: ck-mc then
/// counts the adopted view's edits as served while the runner serves raw
/// history, and builds no recovery.
#[tokio::test]
async fn render_failed_review_report_about_the_view_adopted_in_the_same_notice() {
    let (mut session, client, settings, v1) = fixture_with_view();
    let request = applying(&session, &client, 1, &v1);
    session.notice(&client, &settings, request).await;
    let v2 = session.seal_unchecked(vec![EditOp::Drop {
        mid: "queued".into(),
        part: Some("p".into()),
    }]);
    session.accept(v2.clone());
    let request = applying(&session, &client, 2, &v2);
    session.notice(&client, &settings, request).await;
    assert!(session.unconfirmed.is_empty());
    let offers = offered(&client).len();

    *client.applied.lock().unwrap() = Some(
        AppliedViewAnswer::new()
            .with_view(v1.clone())
            .with_applied_by(crate::MODULE_ID),
    );
    let request = failure(
        &session,
        &client,
        3,
        &v1,
        json!({"code":"render_failed", "mid":"old"}),
    );
    session.notice(&client, &settings, request).await;
    let recovered = offered(&client).len() > offers;
    assert!(
        recovered || session.serves_no_view(session.latest.as_ref()),
        "ck-mc adopted view {} as served although the runner reported serving no view for it",
        v1.version
    );
}

/// A message-only failure excludes every later drop and replace of that
/// message. A queued drop of one of its parts (a `ctx_reduce`) is then
/// removed from the view in `seal`, but the build still reports it covered,
/// so `accept` forgets it as if it had landed: the queue is empty, the part
/// is still served in full, and the build's `freed` estimate counted it.
#[tokio::test]
async fn render_failed_review_queued_drop_in_excluded_message_is_not_forgotten_as_landed() {
    let (mut session, client, settings, view) = fixture_with_view();
    let request = failure(
        &session,
        &client,
        1,
        &view,
        json!({"code":"render_failed", "mid":"old"}),
    );
    session.notice(&client, &settings, request).await;
    let repaired = session.latest.clone().expect("immediate recovery");
    assert_eq!(repaired.version, view.version + 1);

    let key: lanes::PartKey = ("old".into(), "p".into());
    session.queued.insert(key.clone());
    let mut request = applying(&session, &client, 2, &repaired);
    request.conditions.last_prompt_tokens = Some(75_000);
    session.notice(&client, &settings, request).await;
    let latest = session.latest.clone().unwrap();
    let dropped = latest.edits.iter().any(|edit| {
        matches!(&edit.op, EditOp::Drop { mid, part } if mid == "old"
            && part.as_deref().is_none_or(|part| part == "p"))
    });
    assert!(
        dropped || session.queued.contains(&key),
        "the queued drop of old/p was forgotten as landed, but view {} still serves it",
        latest.version
    );
}

fn signed_message_fixture() -> (Session, Client, Settings, View, View) {
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
    let older = session.seal_unchecked(Vec::new());
    session.accept(older.clone());
    let view = session.seal_unchecked(vec![
        EditOp::Replace {
            mid: "old".into(),
            part: "p".into(),
            field: "output".into(),
            value: json!("trimmed"),
            expect: "".into(),
        },
        EditOp::Drop {
            mid: "old".into(),
            part: Some("r".into()),
        },
    ]);
    session.accept(view.clone());
    session.queued.insert(("task".into(), "p".into()));
    (session, client, settings, older, view)
}

/// The hold on a signed-reasoning drop that already failed looks the
/// reasoning part up in the index. A message-only report resets the index
/// inside the same loop, so when one notice carries a report about an older
/// view before the report about the current one, the lookup finds nothing,
/// the hold is not recorded, and the immediate recovery repeats the drop the
/// runner may have failed on. One report alone holds it (see
/// `render_failed_mid_holds_a_candidate_repeating_the_failed_reasoning_drop`).
#[tokio::test]
async fn render_failed_review_reasoning_hold_survives_an_older_report_in_the_same_notice() {
    let (mut session, client, settings, older, view) = signed_message_fixture();
    let mut request = failure(
        &session,
        &client,
        1,
        &view,
        json!({"code":"render_failed", "mid":"old"}),
    );
    request.events.insert(
        0,
        Event::ViewRefused {
            version: older.version,
            refusal: serde_json::from_value(json!({"code":"render_failed"})).unwrap(),
        },
    );
    session.notice(&client, &settings, request).await;
    let repeated: Vec<u64> = offered(&client)
        .iter()
        .filter(|candidate| {
            candidate.edits.iter().any(|edit| {
                matches!(&edit.op, EditOp::Drop { mid, part: Some(part) }
                    if mid == "old" && part == "r")
            })
        })
        .map(|candidate| candidate.version)
        .collect();
    assert!(
        repeated.is_empty(),
        "views {repeated:?} repeat the signed reasoning drop that already failed to render"
    );
}
