//! ck-mc against the `render_failed` worked examples of the compaction
//! contract (cortexkit-role-compaction 0.4.3, CONTRACT.md W6.5 and W6.6a).
//! The reports are the contract's own notice vectors, pinned byte-for-byte in
//! `testdata/compaction-0.4.3-render-failed/` (see its ORIGIN.md).
//!
//! What a report means: `mid` with `part` says the runner serves the view
//! minus every replacement of that part; `mid` alone, or no location, says it
//! serves no view. A runner that cannot serve its one-part skip either
//! reports a no-view shape at that first step, never `mid` with `part`. A
//! version that first reported a one-part skip and later moves to no view
//! sends exactly one more report, in a no-view shape.
//!
//! What ck-mc does about it: for a one-part skip it keeps the accepted view
//! and stops counting that part's replacements as served, without
//! rebuilding; for no view it publishes one recovery view; and when the
//! recovery fails as well it waits for a later permitted rebuild instead of
//! publishing again.

use super::*;
use serde_json::json;

const PART: &str = include_str!(
    "../testdata/compaction-0.4.3-render-failed/notice-render-failed-part-request.json"
);
const MESSAGE: &str = include_str!(
    "../testdata/compaction-0.4.3-render-failed/notice-render-failed-message-request.json"
);
const UNLOCATED: &str = include_str!(
    "../testdata/compaction-0.4.3-render-failed/notice-render-failed-unlocated-request.json"
);
const SUMS: &str = include_str!("../testdata/compaction-0.4.3-render-failed/SHA256SUMS");

/// The view version every vector reports about.
const VERSION: u64 = 7;

/// The one `view_refused` event a vector notice carries, decoded with the
/// wire type ck-mc reads notices with.
fn vector_event(raw: &str) -> Event {
    let raw: Value = serde_json::from_str(raw).unwrap();
    let notice: NoticeRequest = serde_json::from_value(raw["params"].clone()).unwrap();
    let [event] = <[Event; 1]>::try_from(notice.events).expect("a vector carries one event");
    event
}

/// A `render_failed` report about view `version`.
fn report(version: u64, refusal: Value) -> Event {
    Event::ViewRefused {
        version,
        refusal: serde_json::from_value(refusal).unwrap(),
    }
}

/// A session holding view 7, the version the vectors name. The view replaces
/// both the `output` and the `attachments` of `message-b`'s `part-b` (the
/// part the vectors name) and the text of `message-c`. The last prompt
/// reading (`last_prompt_tokens`) is 20,000, well below any threshold, so no
/// pass is permitted to rebuild for pressure.
fn fixture_with_view() -> (Session, Client, Settings, View) {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        Entry::new(
            2,
            "message-b",
            Role::Assistant,
            2,
            vec![output_part("part-b", 2)],
        ),
        text(3, "message-c"),
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
    session.version = VERSION - 1;
    let view = session.seal_unchecked(vec![
        EditOp::Replace {
            mid: "message-b".into(),
            part: "part-b".into(),
            field: "output".into(),
            value: json!("trimmed"),
            expect: String::new().into(),
        },
        EditOp::Replace {
            mid: "message-b".into(),
            part: "part-b".into(),
            field: "attachments".into(),
            value: json!([]),
            expect: String::new().into(),
        },
        EditOp::Replace {
            mid: "message-c".into(),
            part: "p".into(),
            field: "text".into(),
            value: json!("trimmed"),
            expect: session.index.entries()[2].parts[0].digest.clone(),
        },
    ]);
    assert_eq!(view.version, VERSION);
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

/// A notice in which the runner still applies `applied` (W6.6a keeps the
/// accepted view and version) and carries `event`.
fn reporting(
    session: &Session,
    client: &Client,
    seq: u64,
    applied: &View,
    event: Event,
) -> NoticeRequest {
    let mut request = applying(session, client, seq, applied);
    request.events.push(event);
    request
}

fn offered(client: &Client) -> Vec<View> {
    client.offered.lock().unwrap().clone()
}

fn replaces(view: &View, mid: &str, part: &str) -> bool {
    view.edits.iter().any(|edit| {
        matches!(&edit.op,
            EditOp::Replace { mid: m, part: p, .. } if m == mid && p == part)
    })
}

fn edits_message(view: &View, mid: &str) -> bool {
    view.edits.iter().any(|edit| match &edit.op {
        EditOp::Replace { mid: m, .. } | EditOp::Drop { mid: m, .. } => m == mid,
        _ => false,
    })
}

/// The tracked copies are the published bytes, and each carries the shape
/// the tests below rely on.
#[test]
fn render_failed_contract_vectors_are_the_published_examples() {
    use sha2::{Digest, Sha256};
    for (name, raw, refusal) in [
        (
            "notice-render-failed-part-request.json",
            PART,
            json!({"code":"render_failed", "mid":"message-b", "part":"part-b", "field":"attachments"}),
        ),
        (
            "notice-render-failed-message-request.json",
            MESSAGE,
            json!({"code":"render_failed", "mid":"message-b"}),
        ),
        (
            "notice-render-failed-unlocated-request.json",
            UNLOCATED,
            json!({"code":"render_failed"}),
        ),
    ] {
        let line = format!("{:x}  {name}", Sha256::digest(raw.as_bytes()));
        assert!(
            SUMS.lines().any(|sum| sum == line),
            "{name} differs from the published bytes"
        );
        assert_eq!(
            serde_json::to_value(vector_event(raw)).unwrap(),
            json!({"event":"view_refused", "version":VERSION, "refusal":refusal}),
            "{name}"
        );
    }
}

/// `notice-render-failed-part-request.json`: version 7 is served minus every
/// replacement of `part-b`. ck-mc keeps the view, rebuilds nothing, and
/// counts both of the part's replacements as not served, although the
/// report names only `attachments`. The rest of the view stays served.
#[tokio::test]
async fn render_failed_contract_part_report_keeps_the_view_minus_the_parts_replacements() {
    let (mut session, client, settings, view) = fixture_with_view();
    let request = reporting(&session, &client, 1, &view, vector_event(PART));
    session.notice(&client, &settings, request).await;
    assert_eq!(
        session.latest.as_ref(),
        Some(&view),
        "the accepted view was not kept"
    );
    assert_eq!(session.newest_applied, VERSION);
    assert!(
        offered(&client).is_empty(),
        "a one-part skip rebuilt the view"
    );
    assert!(
        !session.serves_no_view(session.latest.as_ref()),
        "a one-part skip was taken as serving no view"
    );
    assert!(session.refused_once.is_empty());
    assert!(session.failed_parts.is_empty());
    let served = session
        .rendered_view(session.latest.as_ref())
        .expect("the view is still served");
    assert!(
        !replaces(&served, "message-b", "part-b"),
        "a replacement of the skipped part still counts as served: {:?}",
        served.edits
    );
    assert!(
        replaces(&served, "message-c", "p"),
        "the rest of the view no longer counts as served"
    );
    assert_eq!(served.edits.len(), view.edits.len() - 2);
}

/// `notice-render-failed-message-request.json` and
/// `notice-render-failed-unlocated-request.json`: no view is served for
/// version 7. A message-only report is also what a runner sends when its
/// one-part skip of that message failed at the first step. ck-mc publishes
/// exactly one recovery view, which leaves a named message unedited and keeps
/// the view's other work. When the runner cannot serve the recovery either,
/// ck-mc publishes nothing more.
#[tokio::test]
async fn render_failed_contract_no_view_report_gets_one_recovery_and_no_repeat() {
    for (shape, vector, recovery_failure) in [
        (
            "message-only",
            MESSAGE,
            json!({"code":"render_failed", "mid":"message-c"}),
        ),
        ("unlocated", UNLOCATED, json!({"code":"render_failed"})),
    ] {
        let (mut session, client, settings, view) = fixture_with_view();
        let request = reporting(&session, &client, 1, &view, vector_event(vector));
        session.notice(&client, &settings, request).await;
        let recovery = session.latest.clone().expect("a recovery view");
        assert_eq!(
            offered(&client),
            vec![recovery.clone()],
            "{shape}: not exactly one recovery view"
        );
        assert_eq!(recovery.version, VERSION + 1, "{shape}");
        if shape == "message-only" {
            assert!(
                !edits_message(&recovery, "message-b"),
                "{shape}: the recovery edits the message the runner named"
            );
        }
        assert!(
            replaces(&recovery, "message-c", "p"),
            "{shape}: the recovery lost the view's other work"
        );
        assert!(session.refused_once.is_empty(), "{shape}");

        let request = reporting(
            &session,
            &client,
            2,
            &recovery,
            report(recovery.version, recovery_failure),
        );
        session.notice(&client, &settings, request).await;
        assert_eq!(
            session.latest.as_ref(),
            Some(&recovery),
            "{shape}: the failed recovery was replaced at once"
        );
        assert!(
            session.serves_no_view(session.latest.as_ref()),
            "{shape}: ck-mc forgot the runner serves no view"
        );
        assert_eq!(
            session.render_failed.recovery(),
            (false, Some(recovery.version)),
            "{shape}: another immediate recovery is pending"
        );
        let request = applying(&session, &client, 3, &recovery);
        session.notice(&client, &settings, request).await;
        assert_eq!(
            offered(&client).len(),
            1,
            "{shape}: a view was published again after the recovery failed"
        );
    }
}

/// The escalation: version 7 first reports the one-part skip of `part-b`
/// (`notice-render-failed-part-request.json`), and a later step cannot serve
/// that skip either, so the runner sends one more report in a no-view shape
/// (`notice-render-failed-message-request.json` or
/// `notice-render-failed-unlocated-request.json`). ck-mc publishes exactly
/// one recovery view, which does not retry the skipped part. The recovery
/// then escalates the same way: a one-part skip, then no view. ck-mc
/// publishes nothing more.
#[tokio::test]
async fn render_failed_contract_escalation_from_part_to_no_view_gets_one_recovery() {
    for (shape, vector, recovery_failure) in [
        (
            "message-only",
            MESSAGE,
            json!({"code":"render_failed", "mid":"message-c"}),
        ),
        ("unlocated", UNLOCATED, json!({"code":"render_failed"})),
    ] {
        let (mut session, client, settings, view) = fixture_with_view();
        let request = reporting(&session, &client, 1, &view, vector_event(PART));
        session.notice(&client, &settings, request).await;
        assert!(
            offered(&client).is_empty(),
            "{shape}: a one-part skip rebuilt the view"
        );
        assert_eq!(session.latest.as_ref(), Some(&view), "{shape}");

        let request = reporting(&session, &client, 2, &view, vector_event(vector));
        session.notice(&client, &settings, request).await;
        let recovery = session.latest.clone().expect("a recovery view");
        assert_eq!(
            offered(&client),
            vec![recovery.clone()],
            "{shape}: the escalation did not get exactly one recovery view"
        );
        assert_eq!(recovery.version, VERSION + 1, "{shape}");
        assert!(
            !replaces(&recovery, "message-b", "part-b"),
            "{shape}: the recovery retried the part the runner skipped"
        );
        if shape == "message-only" {
            assert!(
                !edits_message(&recovery, "message-b"),
                "{shape}: the recovery edits the message the runner named"
            );
        }
        assert!(
            replaces(&recovery, "message-c", "p"),
            "{shape}: the recovery lost the view's other work"
        );

        // The recovery's own first failing step: a one-part skip.
        let request = reporting(
            &session,
            &client,
            3,
            &recovery,
            report(
                recovery.version,
                json!({"code":"render_failed", "mid":"message-c", "part":"p", "field":"text"}),
            ),
        );
        session.notice(&client, &settings, request).await;
        assert_eq!(
            offered(&client).len(),
            1,
            "{shape}: the recovery's one-part skip rebuilt"
        );
        assert_eq!(session.latest.as_ref(), Some(&recovery), "{shape}");
        assert!(!session.serves_no_view(session.latest.as_ref()), "{shape}");

        // Its one more report: no view.
        let request = reporting(
            &session,
            &client,
            4,
            &recovery,
            report(recovery.version, recovery_failure),
        );
        session.notice(&client, &settings, request).await;
        assert_eq!(
            session.latest.as_ref(),
            Some(&recovery),
            "{shape}: the failed recovery was replaced at once"
        );
        assert!(
            session.serves_no_view(session.latest.as_ref()),
            "{shape}: ck-mc forgot the runner serves no view"
        );
        assert_eq!(
            session.render_failed.recovery(),
            (false, Some(recovery.version)),
            "{shape}: another immediate recovery is pending"
        );
        let request = applying(&session, &client, 5, &recovery);
        session.notice(&client, &settings, request).await;
        assert_eq!(
            offered(&client).len(),
            1,
            "{shape}: a view was published again after the recovery failed"
        );
    }
}
