//! ck-mc against the `numbers_unknown` worked examples of the compaction
//! contract (cortexkit-role-compaction 0.4.5, CONTRACT.md T9 to T11, W1.3,
//! W1.4, W6.5 and W7). The vectors are pinned byte-for-byte in
//! `testdata/compaction-0.4.5-numbers-unknown/` (see its ORIGIN.md).
//!
//! What they state: a runner that can't establish how a stretch of history
//! was numbered serves its entries marked `numbers_unknown`, without `tag` on
//! the parts that would carry one. A tag read naming such a number is
//! refused for the rest of the session, and every view must cut through the
//! last such entry or later.
//!
//! What ck-mc does about it: it keeps a marked entry as the entry it already
//! held, answers a refused number with a tool error and never asks for it
//! again, and on a session with a summarizer holds every view until a summary
//! through the last marked entry lets the cut pass it.

use super::*;
use serde_json::json;

#[path = "numbers_unknown_review_tests.rs"]
mod review;

const ENTRIES: &str =
    include_str!("../testdata/compaction-0.4.5-numbers-unknown/entries-numbers-unknown.json");
const NOTICE: &str = include_str!(
    "../testdata/compaction-0.4.5-numbers-unknown/notice-numbers-unknown-request.json"
);
const TRANSITION: &str =
    include_str!("../testdata/compaction-0.4.5-numbers-unknown/numbers-unknown-transition.json");
const CHECKSUM: &str = include_str!(
    "../testdata/compaction-0.4.5-numbers-unknown/checksum-numbers-unknown-marker.json"
);
const REFUSAL: &str =
    include_str!("../testdata/compaction-0.4.5-numbers-unknown/refusal-numbers-unknown.json");
const VIEW_REFUSAL: &str =
    include_str!("../testdata/compaction-0.4.5-numbers-unknown/view-cut-before-numbers.json");
const SUMS: &str = include_str!("../testdata/compaction-0.4.5-numbers-unknown/SHA256SUMS");

/// The transition vector's entry as first served, with tag 1, and as served
/// once the runner fixed its stretch as unknown-number.
fn transition() -> (Entry, Entry) {
    let raw: Value = serde_json::from_str(TRANSITION).unwrap();
    (
        serde_json::from_value(raw["numbered"].clone()).unwrap(),
        serde_json::from_value(raw["marked"].clone()).unwrap(),
    )
}

/// The vector's view refusal: no cut through `message-a`.
fn cut_before_numbers() -> ViewRefusal {
    serde_json::from_str(VIEW_REFUSAL).unwrap()
}

/// The vector's tag-read refusal as the runner client reports a refused
/// call: its code, message and detail.
fn tags_refused() -> crate::client::ClientError {
    let raw: Value = serde_json::from_str(REFUSAL).unwrap();
    let mut error = crate::client::ClientError::refused(
        raw["code"].as_str().unwrap(),
        raw["message"].as_str().unwrap(),
    );
    error.detail = Some(raw["detail"].clone());
    error
}

/// `entry` as a runner serves it once its stretch is unknown-number: marked,
/// its parts without tags, and its digest over the parts as served.
fn marked(mut entry: Entry) -> Entry {
    entry.numbers_unknown = true;
    for part in &mut entry.parts {
        part.tag = None;
    }
    entry.digest = cortexkit_role_compaction::read::entry_digest(
        entry.role.clone(),
        entry.notice.as_ref(),
        &entry.parts,
    );
    entry
}

fn summary(
    db: &ContextDb,
    sequence: i64,
    (start, start_mid): (u64, &str),
    (end, end_mid): (u64, &str),
) {
    db.with_connection(|conn| {
        conn.execute(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, 'work', 'what happened', 'what happened', 1, 'mock')",
            rusqlite::params![sequence, start as i64, end as i64, start_mid, end_mid],
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
}

fn cut_through(view: &View) -> Option<&str> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

#[tokio::test]
async fn audit_cuts_adopt_older_cut_reindexes_visible_tail() {
    let dir = scratch("older-cut");
    let entries: Vec<_> = (1..=10).map(|n| text(n, &format!("m{n}"))).collect();
    let (mut session, client, settings) =
        head(&dir, entries.clone(), &[((1, "m1"), (2, "m2"))]).await;
    let old = session.build(&settings, None, false, None).0.unwrap();
    assert_eq!(cut_through(&old), Some("m2"));
    session.accept(old.clone());
    session.settle_unconfirmed(Some(&old.applied()), &[]);

    summary(session.db.as_ref().unwrap(), 2, (3, "m3"), (6, "m6"));
    session.load_summaries();
    session.summary_unshown = true;
    let new = session.build(&settings, None, false, None).0.unwrap();
    assert_eq!(cut_through(&new), Some("m6"));
    session.accept(new.clone());
    session.settle_unconfirmed(Some(&new.applied()), &[]);
    assert!(session.index.find("m3", "p").is_none());

    *client.applied.lock().unwrap() = Some(
        AppliedViewAnswer::new()
            .with_view(old.clone())
            .with_applied_by(crate::MODULE_ID),
    );
    let mut request = notice(&session, 1, entries.last().map(cursor));
    request.applied_view = Some(old.applied());
    session.notice(&client, &settings, request).await;
    assert_eq!(session.latest.as_ref().unwrap().checksum, old.checksum);
    let reply = session
        .ctx_reduce(&client, &serde_json::json!({"drop": "3-5"}))
        .await
        .unwrap();
    assert_eq!(reply, "3 tags stamped.");
    assert_eq!(session.cut, Some(2));
    assert_eq!(session.index.base(), 2);
    assert!(session.index_ready);
    for ordinal in 3..=5 {
        assert!(session
            .queued
            .contains(&(format!("m{ordinal}"), "p".into())));
    }
    std::fs::remove_dir_all(dir).unwrap();
}

/// A summary's first or last message: its ordinal and id.
type Bound<'a> = (u64, &'a str);

/// A head session (a summarizer, a context store at `dir`) set up over
/// `entries`, with summaries over the given ranges.
async fn head(
    dir: &std::path::Path,
    entries: Vec<Entry>,
    summaries: &[(Bound<'_>, Bound<'_>)],
) -> (Session, Client, Settings) {
    let (mut session, client, route, mut setup, settings) = fixture();
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    for (sequence, (start, end)) in summaries.iter().enumerate() {
        summary(&db, sequence as i64 + 1, *start, *end);
    }
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    setup.newest = entries.last().map(cursor);
    *client.entries.lock().unwrap() = entries;
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    assert!(session.index_ready, "the transcript was read");
    (session, client, settings)
}

/// Every file is the published bytes, and each reads as the contract
/// states it, with the wire types ck-mc reads with. ck-mc declares the
/// capability that lets the runner send them.
#[tokio::test]
async fn numbers_unknown_contract_vectors_are_the_published_bytes_and_read_as_stated() {
    use sha2::{Digest, Sha256};
    for (name, raw) in [
        ("entries-numbers-unknown.json", ENTRIES),
        ("notice-numbers-unknown-request.json", NOTICE),
        ("numbers-unknown-transition.json", TRANSITION),
        ("checksum-numbers-unknown-marker.json", CHECKSUM),
        ("refusal-numbers-unknown.json", REFUSAL),
        ("view-cut-before-numbers.json", VIEW_REFUSAL),
    ] {
        let line = format!("{:x}  {name}", Sha256::digest(raw.as_bytes()));
        assert!(
            SUMS.lines().any(|sum| sum == line),
            "{name} differs from the published bytes"
        );
    }
    let page: ReadPage = serde_json::from_str(ENTRIES).unwrap();
    assert!(page.entries[0].numbers_unknown);
    assert_eq!(page.entries[0].parts[0].tag, None);

    // The same entry, recognised by role, notice and part digests while its
    // entry digest changes with the tag it lost.
    let (numbered, marked) = transition();
    assert_ne!(numbered.digest, marked.digest);
    assert_eq!(
        (&numbered.role, &numbered.notice),
        (&marked.role, &marked.notice)
    );
    assert_eq!(numbered.parts[0].digest, marked.parts[0].digest);
    assert_eq!(numbered.parts[0].tag, Some(1));
    assert_eq!(marked.digest, self::marked(numbered).digest);

    // The marker is outside the checksum.
    let raw: Value = serde_json::from_str(CHECKSUM).unwrap();
    for form in ["with_marker", "without_marker"] {
        let entry: Entry = serde_json::from_value(raw[form].clone()).unwrap();
        assert_eq!(
            cortexkit_role_compaction::read::entry_digest(
                entry.role.clone(),
                entry.notice.as_ref(),
                &entry.parts
            )
            .to_string(),
            raw["checksum"].as_str().unwrap(),
            "{form}"
        );
    }

    // The tag-read refusal names the requested numbers it covers.
    let client = Client::default();
    client.pages.lock().unwrap().push_back(Err(tags_refused()));
    let read = crate::reads::by_tags_placed(
        &client,
        &SessionRef::new("test", "mock", "s1"),
        vec![7, 8],
        crate::reads::Limits::default(),
    )
    .await;
    assert_eq!(
        read,
        Err(crate::reads::TagsRead::NumbersUnknown(vec![7, 8]))
    );

    assert!(matches!(
        cut_before_numbers(),
        ViewRefusal::CutBeforeNumbers { unknown_through } if unknown_through == "message-a"
    ));

    let manifest = serde_json::to_value(crate::transport::manifest(crate::MODULE_ID)).unwrap();
    let claims: Vec<String> =
        serde_json::from_value(manifest["capabilities"]["provides"].clone()).unwrap();
    assert!(cortexkit_role_compaction::provides_numbers_unknown(&claims));
    assert!(claims
        .iter()
        .any(|claim| claim == cortexkit_role_compaction::COMPACTION_PROVIDES));
}

/// `notice-numbers-unknown-request.json` brings back an entry the index
/// holds numbered (`numbers-unknown-transition.json`'s first form). It is the
/// same entry: the notice reads nothing again, the later entry and the drop
/// queued on it stay, and the held copy takes the served form.
#[tokio::test]
async fn numbers_unknown_contract_a_marked_entry_in_a_notice_is_the_entry_already_held() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let (numbered, served) = transition();
    let newest = text(2, "newest");
    *client.entries.lock().unwrap() = vec![numbered, newest.clone()];
    setup.newest = Some(cursor(&newest));
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    assert_eq!(session.index.entries()[0].parts[0].tag, Some(1));
    session.queued.insert(("newest".into(), "p".into()));
    let reads = client.reads.lock().unwrap().len();

    // The runner fixed the stretch as unknown-number; its store serves the
    // marked form from now on.
    client.entries.lock().unwrap()[0] = served.clone();
    let raw: Value = serde_json::from_str(NOTICE).unwrap();
    let mut request: NoticeRequest = serde_json::from_value(raw["params"].clone()).unwrap();
    assert_eq!(request.entries, vec![served.clone()]);
    // The session's own conditions, so the vector's model and window don't
    // read as a change of their own.
    request.conditions = session.conditions.clone();
    request.conditions.statement_epoch = session.statement_epoch.clone();
    request.newest = Some(cursor(&newest));
    session.notice(&client, &settings, request).await;

    assert_eq!(
        client.reads.lock().unwrap().len(),
        reads,
        "a marked entry made ck-mc read the transcript again"
    );
    let held = &session.index.entries()[0];
    assert!(held.numbers_unknown);
    assert_eq!(held.parts[0].tag, None);
    assert_eq!(held.digest, served.digest);
    assert_eq!(session.index.entries()[1], newest);
    assert!(session.queued.contains(&("newest".into(), "p".into())));
    assert!(session.index.ends_at(Some(&cursor(&newest))));
}

/// Setup reads the transcript again from the index's base. A marked entry
/// in that read continues the index: one read, not a second one from the cut.
#[tokio::test]
async fn numbers_unknown_contract_a_marked_entry_read_at_setup_is_not_read_twice() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let (numbered, served) = transition();
    let later: Vec<Entry> = (2..=4).map(|n| text(n, &format!("m{n}"))).collect();
    let mut entries = vec![numbered];
    entries.extend(later.iter().cloned());
    *client.entries.lock().unwrap() = entries.clone();
    setup.newest = entries.last().map(cursor);
    let features = session.features;
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;

    client.entries.lock().unwrap()[0] = served.clone();
    client.reads.lock().unwrap().clear();
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    let reads = client.reads.lock().unwrap().clone();
    assert_eq!(
        reads
            .iter()
            .filter(|read| matches!(read.select, Select::After { .. }))
            .count(),
        1,
        "the index was read again from the cut: {reads:?}"
    );
    assert!(session.index_ready);
    assert_eq!(session.index.entries()[0].digest, served.digest);
    assert_eq!(&session.index.entries()[1..], &later[..]);
}

/// `refusal-numbers-unknown.json`: `ctx_reduce` naming those numbers gets a
/// tool error saying why, stamps nothing, and neither it nor `ctx_expand`
/// asks the runner for them again, after a restart too.
#[tokio::test]
async fn numbers_unknown_contract_refused_numbers_get_a_tool_error_and_are_never_asked_again() {
    let (mut session, client, _, _, settings) = fixture();
    session.index.extend([text(1, "a"), text(2, "b")]);
    session.index_ready = true;
    client.pages.lock().unwrap().push_back(Err(tags_refused()));
    let answer = session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop": "2,7-8"}))
        .await
        .unwrap();
    assert!(
        answer.starts_with("Error: §7§, §8§ can't be addressed by tag number"),
        "{answer}"
    );
    // A worker has no summaries, so the error sends the model to the
    // messages themselves.
    assert!(
        answer.contains("Read it by message instead: ctx_expand message=<ordinal>"),
        "{answer}"
    );
    assert!(!answer.contains("summaries cover it"), "{answer}");
    assert!(session.queued.is_empty(), "the call stamped something");
    let reads = |client: &Client| client.reads.lock().unwrap().clone();
    assert_eq!(reads(&client).len(), 1);
    assert!(matches!(
        &reads(&client)[0].select,
        Select::Tags { tags } if tags == &[7, 8]
    ));

    let again = session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop": "8"}))
        .await
        .unwrap();
    assert!(
        again.starts_with("Error: §8§ can't be addressed"),
        "{again}"
    );
    let expanded = session
        .tool(&client, &settings, "ctx_expand", &json!({"tag": 7}))
        .await
        .unwrap_err();
    assert!(
        expanded.starts_with("Error: §7§ can't be addressed"),
        "{expanded}"
    );
    assert_eq!(
        reads(&client).len(),
        1,
        "a refused number was asked for again"
    );

    // A number refused to `ctx_expand` first is remembered the same way.
    let mut refused = crate::client::ClientError::refused("numbers_unknown", "unknown");
    refused.detail = Some(json!({"tags": [9]}));
    client.pages.lock().unwrap().push_back(Err(refused));
    for _ in 0..2 {
        let expanded = session
            .tool(&client, &settings, "ctx_expand", &json!({"tag": 9}))
            .await
            .unwrap_err();
        assert!(
            expanded.starts_with("Error: §9§ can't be addressed"),
            "{expanded}"
        );
    }
    assert_eq!(reads(&client).len(), 2);
    assert_eq!(
        session.durable().numbers_unknown_tags,
        BTreeSet::from([7, 8, 9]),
        "the refused numbers are not kept across a restart"
    );
}

/// Marked entries' parts have no tag, and nothing ck-mc derives from them
/// invents one: a drop queued on such a part, `ctx_keep`, the summarizer's
/// input and `ctx_expand`'s range rendering all go without a number.
#[tokio::test]
async fn numbers_unknown_contract_tagless_parts_get_no_invented_number() {
    let (mut session, client, _, _, settings) = fixture();
    let page: ReadPage = serde_json::from_str(ENTRIES).unwrap();
    let served = page.entries[0].clone();
    session
        .index
        .extend([served.clone(), text(2, "b"), text(3, "c")]);
    session.index_ready = true;
    session.queued.insert(("message-a".into(), "part-a".into()));
    let (view, _) = session.build(&settings, None, false, None);
    let numbered = view.iter().flat_map(|view| &view.edits).any(|edit| {
        serde_json::to_string(&edit.op)
            .unwrap()
            .contains("message-a")
    });
    assert!(
        !numbered,
        "an edit was built for a part with no number: {view:?}"
    );

    let kept = session
        .tool(
            &client,
            &settings,
            "ctx_keep",
            &json!({"tags": "1", "note": "where I am"}),
        )
        .await
        .unwrap();
    assert!(kept.contains("Not found: §1§"), "{kept}");

    // The vector's entry is a notice, which the summarizer leaves out; a
    // person's marked message is summarized without a number.
    let counter = crate::count::Counter::for_model(None);
    let person = marked(text(4, "a person's words"));
    let chunk = crate::summary::chunk::build(std::slice::from_ref(&person), 1_000, counter)
        .expect("the marked entry is summarized");
    assert!(chunk.input.contains("a person's words"), "{}", chunk.input);
    assert!(!chunk.input.contains('§'), "{}", chunk.input);
}

/// The last marked entry is past the summaries: a summary through it is due
/// at once, at any usage, over a chunk that reaches it and keeps its last
/// compartment. Until it lands no view is published, and queued drops wait.
/// Once it lands, the next notice publishes a view cutting past it, though
/// usage alone would rebuild nothing.
#[tokio::test]
async fn numbers_unknown_contract_views_wait_for_a_summary_through_the_last_marked_entry() {
    let logs = crate::test_log::capture();
    let dir = scratch("numbers-floor");
    let mut entries: Vec<Entry> = (1..=10).map(|n| text(n, &format!("m{n}"))).collect();
    for at in [4, 5] {
        entries[at] = marked(entries[at].clone());
    }
    let (mut session, client, settings) = head(&dir, entries, &[((1, "m1"), (3, "m3"))]).await;
    assert_eq!(
        session.numbers_floor(),
        Some(MoveFloor {
            ordinal: 6,
            mid: "m6".into()
        })
    );

    session.queued.insert(("m8".into(), "p".into()));
    let (view, _) = session.build(&settings, None, false, None);
    assert!(
        view.is_none(),
        "a view cutting before m6 was built: {view:?}"
    );
    assert!(session.queued.contains(&("m8".into(), "p".into())));
    assert_eq!(logs.count("cut_before_numbers"), 1);

    assert_eq!(pass::usage(&session.pressure()).unwrap_or(0.0), 0.0);
    let run = session
        .summary_due(&settings)
        .expect("a summary through the last marked entry is due at any usage");
    assert_eq!(
        (run.from, run.until, run.force_keep_last_compartment),
        (4, 7, true)
    );

    // The summary lands. A head that is otherwise current has no reason of
    // its own to rebuild at this usage.
    session.summarizing = false;
    summary(session.db.as_ref().unwrap(), 2, (4, "m4"), (7, "m7"));
    session.load_summaries();
    session.summary_unshown = true;
    session.head_stale = false;
    assert!(session.rebuild_permitted(&settings));
    let entry = text(11, "m11");
    client.entries.lock().unwrap().push(entry.clone());
    let mut request = notice(&session, 1, Some(cursor(&entry)));
    request.entries = vec![entry];
    session.notice(&client, &settings, request).await;
    let offered = client.offered.lock().unwrap().clone();
    assert_eq!(offered.len(), 1, "no view after the summary passed m6");
    assert_eq!(cut_through(&offered[0]), Some("m7"));
    assert_eq!(logs.count("views publish again"), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

/// `view-cut-before-numbers.json`: the runner refuses a view because it
/// cuts before `message-a`, which the index still holds numbered. The drop
/// the view carried was not at fault and stays queued; the next view waits
/// for `message-a` to be covered instead of repeating the refused cut.
/// `message-a` is a module notice, which the summarizer leaves out, and
/// what follows it is all in the protected tail: no summary run can cover
/// it, so it counts as covered for the cut, and the next view cuts there.
#[tokio::test]
async fn numbers_unknown_contract_a_cut_before_numbers_refusal_is_not_resent() {
    let dir = scratch("numbers-refused");
    let (numbered, _) = transition();
    let mut entries = vec![numbered];
    entries.extend((2..=6).map(|n| text(n, &format!("m{n}"))));
    let (mut session, client, settings) = head(&dir, entries, &[]).await;
    session.queued.insert(("m4".into(), "p".into()));
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("no floor is known yet");
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(cut_before_numbers());
    session.publish(&client, view).await;

    assert!(session.queued.contains(&("m4".into(), "p".into())));
    assert!(session.refused_once.is_empty(), "the drop was blamed");
    assert_eq!(
        session.numbers_floor(),
        Some(MoveFloor {
            ordinal: 1,
            mid: "message-a".into()
        })
    );
    let (again, _) = session.build(&settings, None, false, None);
    assert!(
        again.is_none(),
        "the refused cut was built again: {again:?}"
    );
    assert_eq!(client.offered.lock().unwrap().len(), 1);
    assert!(
        session.summary_due(&settings).is_none(),
        "a summary run started over a notice it can't summarize"
    );
    assert!(!session.short_of_numbers_floor());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the hold ended");
    assert_eq!(cut_through(&view), Some("message-a"));
    std::fs::remove_dir_all(dir).unwrap();
}

/// A long tag selection goes out in several requests. A refusal that names
/// no numbers marks only what its own request asked for, never the numbers
/// an earlier request already answered.
#[tokio::test]
async fn numbers_unknown_contract_a_refusal_without_tags_marks_only_its_own_request() {
    let client = Client::default();
    let answered = text(1, "one");
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Ok(ReadPage::new(vec![answered.clone()], Head::new())));
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::refused(
            "numbers_unknown",
            "unknown",
        )));
    let limits = crate::reads::Limits {
        select_max: Some(2),
        ..Default::default()
    };
    let read = crate::reads::by_tags_placed(
        &client,
        &SessionRef::new("test", "mock", "s1"),
        vec![1, 2, 3],
        limits,
    )
    .await;
    assert_eq!(read, Err(crate::reads::TagsRead::NumbersUnknown(vec![3])));
}

/// A tool call still running at or before the last marked entry keeps every
/// cut before it, while no view may cut before that entry. Views stay held,
/// and the log names the call once.
#[tokio::test]
async fn numbers_unknown_contract_a_running_call_below_the_floor_is_named_once() {
    let logs = crate::test_log::capture();
    let dir = scratch("numbers-running");
    let mut entries: Vec<Entry> = (1..=8).map(|n| text(n, &format!("m{n}"))).collect();
    let running: Part = serde_json::from_value(json!({
        "id": "p", "kind": "tool", "call_id": "call-7", "name": "bash",
        "input": {}, "status": "running", "digest": "running",
    }))
    .unwrap();
    entries[2] = Entry::new(3, "m3", Role::Assistant, 3, vec![running]);
    entries[4] = marked(entries[4].clone());
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (6, "m6"))]).await;
    assert!(!session.short_of_numbers_floor());
    for _ in 0..2 {
        let (view, _) = session.build(&settings, None, false, None);
        assert!(view.is_none(), "a view cut before m5: {view:?}");
    }
    assert_eq!(logs.count("bash call call-7 is still running"), 1);
    std::fs::remove_dir_all(dir).unwrap();
}
