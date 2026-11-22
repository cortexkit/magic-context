//! Defects found reviewing ck-mc's handling of history the runner serves
//! without part numbers (`numbers_unknown`, compaction contract T9 to T11).
//! Each test states a property the handling should have and fails on the
//! code it was written against.

use super::*;

/// `entry` as a module notice: the summarizer leaves a notice's own text
/// out, so a range holding only notices gives it nothing to summarize.
fn as_notice(mut entry: Entry) -> Entry {
    entry.notice = Some(
        serde_json::from_value(json!({"sender": "example-notifier", "template": "example"}))
            .unwrap(),
    );
    entry.digest = cortexkit_role_compaction::read::entry_digest(
        entry.role.clone(),
        entry.notice.as_ref(),
        &entry.parts,
    );
    entry
}

/// A message whose text is `words` words long, tagged with its ordinal.
fn long_text(ordinal: u64, words: usize) -> Entry {
    let mut part = Part::new(
        "p",
        PartBody::Text {
            text: "word ".repeat(words).into(),
        },
    );
    part.tag = Some(ordinal);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::User,
        ordinal,
        vec![part],
    )
}

/// The last marked entry is a notice right after the summaries' end, which
/// the summarizer leaves out. Two cases:
///
/// - What follows the notice is all in the protected tail, which stays raw.
///   No summary run can reach the floor, so none starts over a range that
///   renders nothing. The entries through the floor count as covered for
///   the cut instead (cutting them loses nothing a summary would keep): the
///   hold ends, the next view cuts through the notice, and that finding is
///   logged once.
/// - A later entry outside the protected tail renders. A real run then
///   reads on past the notice, as the usual trigger would, and covers
///   through the floor.
#[tokio::test]
async fn numbers_review_the_summary_due_before_any_view_can_reach_a_floor_the_summarizer_skips() {
    let logs = crate::test_log::capture();
    let dir = scratch("numbers-review-notice-floor");
    let mut entries: Vec<Entry> = (1..=10).map(|n| text(n, &format!("m{n}"))).collect();
    entries[3] = marked(as_notice(entries[3].clone()));
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (3, "m3"))]).await;
    assert_eq!(session.numbers_floor().map(|floor| floor.ordinal), Some(4));
    assert!(session.short_of_numbers_floor());

    for _ in 0..2 {
        assert!(
            session.summary_due(&settings).is_none(),
            "a summary run started over a range the summarizer can't summarize"
        );
    }
    assert!(!session.summarizing);
    assert!(!session.short_of_numbers_floor(), "the hold did not end");
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("a view once the hold ends");
    assert_eq!(cut_through(&view), Some("m4"));
    assert_eq!(logs.count("hold nothing a summary would keep"), 1);
    std::fs::remove_dir_all(&dir).unwrap();

    let dir = scratch("numbers-review-notice-floor-later");
    let mut entries: Vec<Entry> = (1..=10).map(|n| long_text(n, 8_000)).collect();
    entries[3] = marked(as_notice(entries[3].clone()));
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (3, "m3"))]).await;
    assert_eq!(session.numbers_floor().map(|floor| floor.ordinal), Some(4));
    let run = session
        .summary_due(&settings)
        .expect("a summary through the last marked entry is due");
    assert_eq!(run.from, 4);
    assert!(
        run.until > 5,
        "the run stops at the floor: {}..{}",
        run.from,
        run.until
    );
    let read: Vec<Entry> = session
        .index
        .entries()
        .iter()
        .filter(|entry| entry.ordinal >= run.from && entry.ordinal < run.until)
        .cloned()
        .collect();
    let chunk = crate::summary::chunk::build(&read, 50_000, crate::count::Counter::for_model(None));
    assert!(
        chunk.is_some(),
        "the run over messages {}..{} gives the summarizer nothing to summarize, so it can never reach the floor at {}",
        run.from,
        run.until,
        4
    );
    assert!(run.force_keep_last_compartment);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn kept_notice_alone_at_the_numbers_floor_requires_a_summary() {
    use cortexkit_role_compaction::read::NoticeOrigin;

    let dir = scratch("numbers-review-kept-notice-floor");
    let mut entries: Vec<Entry> = (1..=10).map(|n| text(n, &format!("m{n}"))).collect();
    entries[3] = marked(
        entries[3]
            .clone()
            .with_notice(NoticeOrigin::new("core").with_keep(true)),
    );
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (3, "m3"))]).await;
    let run = session
        .summary_due(&settings)
        .expect("the kept notice needs a summary, not an uncovered cut");
    assert_eq!((run.from, run.until), (4, 5));
    assert!(run.force_keep_last_compartment);
    assert!(session.short_of_numbers_floor());
    assert!(session.build(&settings, None, false, None).0.is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

/// The summary due before any view reads from the summaries' end through
/// the floor in one run, however long that is. Every other automatic run,
/// and a person's wrap-up, reads at most the per-run cap
/// (`trigger::cap_run`), and the next run continues from where it stopped.
#[tokio::test]
async fn numbers_review_the_summary_due_before_any_view_keeps_the_per_run_cap() {
    let dir = scratch("numbers-review-cap");
    let mut entries: Vec<Entry> = (1..=10).map(|n| long_text(n, 8_000)).collect();
    entries[8] = marked(entries[8].clone());
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (1, "m1"))]).await;
    let floor = session.numbers_floor().expect("a floor").ordinal;
    assert_eq!(floor, 9);

    let usage = pass::usage(&session.pressure()).unwrap_or(0.0) * 100.0;
    let cap = trigger::per_run_cap(
        pass::usable_window(&session.conditions),
        settings.execute_threshold_percentage,
        usage,
    );
    let capped = trigger::cap_run(
        session.index.entries(),
        entry_removed_tokens,
        2,
        floor + 1,
        cap,
    );
    assert!(
        capped < floor + 1,
        "the history up to the floor fits one capped run ({cap} tokens), so this test proves nothing"
    );
    let run = session
        .summary_due(&settings)
        .expect("a summary through the last marked entry is due");
    assert!(
        run.until <= capped,
        "the run reads messages {}..{}, past the per-run cap of {cap} tokens, which ends at {capped}",
        run.from,
        run.until
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// A session without a summarizer (a worker or reader) can never cut, so
/// every view it builds is refused `cut_before_numbers` once its history
/// holds marked entries. The refusal must not leave the same view to be
/// built and refused again on every pass. When ck-mc didn't know the code,
/// it read it as an ordinary refusal and set the view's drops aside; now it
/// holds further views instead, so no drop is blamed for a refusal it didn't
/// cause.
#[tokio::test]
async fn numbers_review_a_session_without_a_summarizer_does_not_resend_a_view_refused_for_numbers()
{
    let (mut session, client, _, _, settings) = fixture();
    assert!(!session.features.summarizer);
    session
        .index
        .extend((1..=6).map(|n| text(n, &format!("m{n}"))));
    session.index_ready = true;
    session.queued.insert(("m3".into(), "p".into()));
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the queued drop builds a view");
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::CutBeforeNumbers {
        unknown_through: "m1".into(),
    });
    session.publish(&client, view).await;
    assert_eq!(client.offered.lock().unwrap().len(), 1);

    let (again, _) = session.build(&settings, None, false, None);
    if let Some(again) = again {
        session.publish(&client, again).await;
    }
    assert_eq!(
        client.offered.lock().unwrap().len(),
        1,
        "a view the runner refuses for any cut this session can make was sent again"
    );
}

/// While views wait for a summary through the numbers floor, `/ctx-flush`
/// can land nothing. Its preview must not tell the person there is nothing
/// to land, or that the queued drops sit in the recent tail, when drops are
/// queued and only the hold keeps them back. A moved session whose
/// summaries stop short of its move floor (see `move_floor`) reports itself
/// unmanaged instead.
#[tokio::test]
async fn numbers_review_the_flush_preview_does_not_misreport_a_numbers_hold() {
    let logs = crate::test_log::capture();
    let dir = scratch("numbers-review-flush");
    let mut entries: Vec<Entry> = (1..=10).map(|n| text(n, &format!("m{n}"))).collect();
    entries[5] = marked(entries[5].clone());
    let (mut session, _client, settings) = head(&dir, entries, &[((1, "m1"), (3, "m3"))]).await;
    assert!(session.short_of_numbers_floor());
    session.queued.insert(("m8".into(), "p".into()));
    let preview = session.command_preview(&settings, "flush");
    assert!(
        !matches!(
            preview.reason.as_deref(),
            Some("nothing_to_land" | "queued_in_recent_tail")
        ),
        "the flush preview blames the queue for a numbers hold: {preview:?}"
    );
    // It names the hold, and no preview logs it: only the live session does.
    assert_eq!(
        preview.reason.as_deref(),
        Some("waiting_for_numbers_summary")
    );
    assert_eq!(logs.count("cut_before_numbers"), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

/// A session without a summarizer has no summaries. The tool error for a
/// refused tag number must not tell its model that the session's summaries
/// cover that history.
#[tokio::test]
async fn numbers_review_the_refused_number_error_claims_no_summaries_a_session_lacks() {
    let (mut session, client, _, _, settings) = fixture();
    assert!(!session.features.summarizer);
    session.index.extend([text(1, "a"), text(2, "b")]);
    session.index_ready = true;
    client.pages.lock().unwrap().push_back(Err(tags_refused()));
    let answer = session
        .tool(&client, &settings, "ctx_reduce", &json!({"drop": "7"}))
        .await
        .unwrap();
    assert!(answer.starts_with("Error: "), "{answer}");
    assert!(
        !answer.contains("summaries cover it"),
        "a session with no summaries is told its summaries cover the history: {answer}"
    );
}
