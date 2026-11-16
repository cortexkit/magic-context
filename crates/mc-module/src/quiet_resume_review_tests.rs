//! Witnesses from a review of freeing quiet sessions, on the session itself
//! ([`Session::quiet_carry`], [`Session::resume_quiet`]). Each test runs the
//! same steps on a session never freed and on one freed and resumed, and
//! fails while the two differ: freeing must change nothing but the memory a
//! session holds.

use super::*;

/// Make `context.db`'s summaries unreadable (`hidden`), or readable again,
/// as a store that is busy or briefly unavailable answers.
fn hide_summaries(db: &ContextDb, hidden: bool) {
    let sql = if hidden {
        "ALTER TABLE compartments RENAME TO compartments_hidden"
    } else {
        "ALTER TABLE compartments_hidden RENAME TO compartments"
    };
    db.with_connection(|conn| conn.execute_batch(sql)).unwrap();
}

/// Resuming reads the summaries again from `context.db`. When that read
/// fails, the session keeps only the newest summary, which freeing left it,
/// and carries on as if that were all its history: nothing marks the
/// summaries as unread, so no later job reads them again, and the next fold
/// renders `m[0]` from that one summary. A session never freed renders all
/// of them. (After a restart a failed read leaves no summary at all, and the
/// saved state is rebuilt from `context.db`; the resume does neither.)
#[tokio::test]
async fn quiet_review_a_failed_summary_read_on_resume_loses_no_history() {
    let (mut kept, kept_client, _kept_app, settings) = settled("quiet-review-kept").await;
    let (freed, client, _app, _) = settled("quiet-review-freed").await;
    let db = Arc::clone(freed.db.as_ref().unwrap());
    let Ok(carry) = Box::new(freed).quiet_carry() else {
        panic!("a session with nothing in flight is quiet");
    };
    hide_summaries(&db, true);
    let mut resumed = Session::resume_quiet(carry);
    hide_summaries(&db, false);

    // The next fold, as a model change or a refold makes one.
    for (session, client) in [(&mut kept, &kept_client), (&mut resumed, &client)] {
        session.fold_due = true;
        session.head_stale = true;
        let newest = client.entries.lock().unwrap().last().map(cursor);
        let mut request = notice(session, 3, newest);
        request.conditions.statement_seq = Some(4);
        request.applied_view = client
            .applied
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|answer| answer.view.as_ref())
            .map(View::applied);
        session.notice(client, &settings, request).await;
    }
    let head = |session: &Session| {
        session.latest.as_ref().and_then(|view| {
            view.edits.iter().find_map(|edit| match &edit.op {
                EditOp::Insert { message, .. } if message.id == head::M0_ID => {
                    Some(serde_json::to_string(message).unwrap())
                }
                _ => None,
            })
        })
    };
    assert!(
        head(&kept).is_some_and(|m0| m0.contains("first")),
        "the fold shows the first summary"
    );
    assert_eq!(head(&kept), head(&resumed), "m[0] after the next fold");
    assert_eq!(
        kept.summaries.to_vec(),
        resumed.summaries.to_vec(),
        "the summaries the session works from"
    );
}

/// A view the runner refused at a step boundary for a reason the moving
/// transcript explains (the final turn removed, an unknown message) gets one
/// retry without blame; if that retry is refused for the same reason, its
/// drops are blamed as usual. The bound lives only in memory. Resuming reads
/// the runner's view back, which clears the bound, so a session freed
/// between the refusal and the retry lets the retry go unblamed too.
#[tokio::test]
async fn quiet_review_a_freed_session_keeps_the_bound_on_an_immediate_retry() {
    let (mut session, client, settings) = refusal_fixture();
    // A store, so the apps' decisions are saved and the session can be freed.
    let dir = scratch("quiet-review-retry");
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).unwrap());
    session.set_store(Some(Arc::clone(&store)));
    let app = crate::app_read::AppRead::new(Some(store.path.clone()), None);
    // The first view drops only the old outputs; the model's drops come later.
    session.queued.clear();
    let (view, _) = session.build(&settings, None, false, None);
    let first = view.expect("the old outputs are dropped");
    session.publish(&client, first.clone()).await;
    session.publish_app(&app, true);
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(first.clone());
    answer.applied_by = Some(crate::MODULE_ID.to_owned());
    *client.applied.lock().unwrap() = Some(answer);

    /// A notice that reports the runner applying `applied`, with the newest
    /// view refused at a step boundary if `refuse` is set.
    #[allow(clippy::too_many_arguments)]
    async fn report(
        session: &mut Session,
        client: &Client,
        settings: &Settings,
        app: &crate::app_read::AppRead,
        seq: u64,
        applied: &View,
        refuse: bool,
    ) {
        let newest = client.entries.lock().unwrap().last().map(cursor);
        let mut request = notice(session, seq, newest);
        request.applied_view = Some(applied.applied());
        if refuse {
            let version = session.latest.as_ref().unwrap().version;
            request.events.push(Event::ViewRefused {
                version,
                refusal: final_turn_refusal(),
            });
        }
        session.notice(client, settings, request).await;
        session.publish_app(app, false);
    }

    report(&mut session, &client, &settings, &app, 1, &first, false).await;
    assert!(
        session.unconfirmed.is_empty(),
        "the runner applies the view"
    );
    // The model drops two parts; the runner takes the view carrying them,
    // then refuses it at its next step.
    session.queued = queued_refusal_parts();
    let (view, _) = session.build(&settings, None, false, None);
    session.publish(&client, view.unwrap()).await;
    report(&mut session, &client, &settings, &app, 2, &first, true).await;
    assert!(
        session.transcript_retry.is_some(),
        "the refusal bounds the immediate retry"
    );
    assert_eq!(
        session.latest.as_ref(),
        Some(&first),
        "the view rolled back"
    );

    let mut kept = session.clone();
    let Ok(carry) = Box::new(session).quiet_carry() else {
        panic!("a session with nothing in flight is quiet");
    };
    let mut resumed = Session::resume_quiet(carry);

    // The retry, refused for the same reason.
    for session in [&mut kept, &mut resumed] {
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("the retry carries the model's drops");
        assert_carries_queued_drops(&view);
        session.publish(&client, view).await;
        report(session, &client, &settings, &app, 3, &first, true).await;
    }
    assert_eq!(
        kept.refused_once, resumed.refused_once,
        "drops blamed for the refused retry (the never-freed session held the bound {:?})",
        kept.transcript_retry
    );
    let _ = std::fs::remove_dir_all(dir);
}

/// A head with 3,000 summaries in `context.db` and 300,000 entries after
/// the cut, each a text of about 300 characters, whose runner applies the
/// view a notice built: a large session with nothing in flight.
struct LargeHead {
    session: Session,
    client: Client,
    /// The apps' reads of the session, which [`quiet_review_large_head_parts`]
    /// publishes to.
    #[cfg_attr(not(feature = "heap-profile"), allow(dead_code))]
    app: crate::app_read::AppRead,
    dir: std::path::PathBuf,
    /// The transcript after the cut as compact JSON, in bytes.
    after_cut_bytes: usize,
    /// How long the Setup that read the whole transcript took.
    setup_ms: u128,
}

async fn large_head(label: &str) -> LargeHead {
    const SUMMARIES: u64 = 3_000;
    const AFTER_CUT: u64 = 300_000;
    let (mut session, client, route, mut setup, settings) = fixture();
    let dir = scratch(label);
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let content = "Reworked the parser's error recovery so that a missing brace no longer \
        swallows the rest of the file; added tests for nested blocks, trailing commas and \
        unterminated strings; the lexer now reports the column of the first bad byte. \
        Open question: whether the formatter should keep comments inside empty blocks.";
    db.with_connection(|conn| {
        let tx = conn.transaction().unwrap();
        {
            let mut insert = tx
                .prepare(
                    "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness)
                     VALUES ('s1', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 1, 'mock')",
                )
                .unwrap();
            for sequence in 1..=SUMMARIES {
                let start = sequence * 2 - 1;
                insert
                    .execute(rusqlite::params![
                        sequence,
                        start,
                        start + 1,
                        format!("m{start}"),
                        format!("m{}", start + 1),
                        format!("Step {sequence}"),
                        content,
                    ])
                    .unwrap();
            }
        }
        tx.commit().unwrap();
    });
    session.db = Some(Arc::new(db));
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).unwrap());
    session.set_store(Some(Arc::clone(&store)));
    let app = crate::app_read::AppRead::new(Some(store.path.clone()), None);
    session.load_summaries();
    assert_eq!(session.summaries.len() as u64, SUMMARIES);
    let entry = |ordinal: u64| {
        let text = format!(
            "Message {ordinal}: read src/parser/block_{}.rs and ran the tests again; {} of them \
             pass now, the rest fail on the trailing-comma case, which the lexer reports at \
             column {}. Next: keep the recovery token and resynchronise on the closing brace.",
            ordinal % 97,
            ordinal % 41,
            ordinal % 113
        );
        let mut part = Part::new("p", PartBody::Text { text: text.into() });
        part.tag = Some(ordinal);
        let role = if ordinal % 2 == 1 {
            Role::User
        } else {
            Role::Assistant
        };
        Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, vec![part])
    };
    let entries: Vec<Entry> = (1..=SUMMARIES * 2 + AFTER_CUT).map(entry).collect();
    let after_cut_bytes: usize = entries[(SUMMARIES * 2) as usize..]
        .iter()
        .map(|entry| serde_json::to_vec(entry).unwrap().len())
        .sum();
    *client.entries.lock().unwrap() = entries;
    setup.newest = client.entries.lock().unwrap().last().map(cursor);
    let features = Features {
        summarizer: true,
        ..session.features
    };
    let started = std::time::Instant::now();
    session
        .setup(&client, &settings, &route, &setup, features)
        .await;
    let setup_ms = started.elapsed().as_millis();
    session.publish_app(&app, true);
    // A head that is due builds a view with the history and the cut.
    session.head_stale = true;
    let request = notice(&session, 1, setup.newest.clone());
    session.notice(&client, &settings, request).await;
    session.publish_app(&app, false);
    let view = session.latest.clone().expect("the notice built a view");
    let mut answer = AppliedViewAnswer::new();
    answer.view = Some(view.clone());
    answer.applied_by = Some(crate::MODULE_ID.to_owned());
    *client.applied.lock().unwrap() = Some(answer);
    let mut request = notice(&session, 2, setup.newest.clone());
    request.applied_view = Some(view.applied());
    session.notice(&client, &settings, request).await;
    session.publish_app(&app, false);
    assert!(
        session.unconfirmed.is_empty(),
        "the runner applies the view"
    );
    // The transcript after the cut is far past any summary trigger; what is
    // measured here is the restore, so the summary run the notices started
    // is taken as finished.
    session.summarizing = false;
    session.run_start = None;
    session.reservation = None;
    LargeHead {
        session,
        client,
        app,
        dir,
        after_cut_bytes,
        setup_ms,
    }
}

/// How long restoring a large freed head takes ([`large_head`]). The runner
/// here answers every read at once and in one page; a real runner serves
/// pages of at most 1 MiB, each a round trip, so the test also reports how
/// many such pages the transcript fills. Run it with
/// `--release --ignored --nocapture`.
#[tokio::test]
#[ignore = "a measurement, run on request with --release --ignored --nocapture"]
async fn quiet_review_resume_time_for_a_large_head() {
    let LargeHead {
        session,
        client,
        dir,
        after_cut_bytes,
        setup_ms,
        ..
    } = large_head("quiet-review-large-head").await;
    let cut = session.cut;
    let indexed = session.index.entries().len();

    let started = std::time::Instant::now();
    let loaded = session
        .db
        .as_ref()
        .unwrap()
        .compartments("mock", "s1")
        .unwrap()
        .len();
    let load_ms = started.elapsed().as_millis();
    let started = std::time::Instant::now();
    let Ok(carry) = Box::new(session).quiet_carry() else {
        panic!("the session is quiet");
    };
    let free_ms = started.elapsed().as_millis();
    let reads = client.reads.lock().unwrap().len();
    let started = std::time::Instant::now();
    let resumed = Session::resume_quiet(carry);
    let resume_ms = started.elapsed().as_millis();
    let resume_reads = client.reads.lock().unwrap().len() - reads;
    assert!(resumed.index_ready, "the carry kept the transcript index");
    assert_eq!(resumed.index.entries().len(), indexed);
    eprintln!(
        "quiet resume of a large head: {loaded} summaries, cut {cut:?}, {indexed} entries indexed after the cut \
         ({} MiB as compact JSON, {} pages of 1 MiB from a real runner); Setup with the whole \
         transcript {setup_ms} ms; summary read alone {load_ms} ms; freeing {free_ms} ms; \
         resume {resume_ms} ms in {resume_reads} runner reads",
        after_cut_bytes >> 20,
        after_cut_bytes.div_ceil(1 << 20)
    );
    drop(resumed);
    let _ = std::fs::remove_dir_all(dir);
}

/// dhat as the allocator, so a measurement can read the bytes held live.
/// Only a build with `heap-profile` has it; without a running profiler it
/// passes every allocation straight to the system allocator.
#[cfg(feature = "heap-profile")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

/// What a large idle head ([`large_head`]) holds, part by part, and what
/// freeing it keeps; then how long its restore takes, and what the restore
/// would add if the carry dropped the transcript index, the view and the
/// view checks. Bytes are the requested sizes dhat counts live, measured as what
/// dropping each part frees, in an order that charges a shared allocation
/// to the part dropped last. Run it alone, in a release build:
/// `--release --features agent-data,heap-profile -- --ignored --nocapture
/// quiet_review_large_head_parts`.
#[cfg(feature = "heap-profile")]
#[tokio::test]
#[ignore = "a measurement, run on request with --release --features heap-profile --ignored --nocapture"]
async fn quiet_review_large_head_parts() {
    fn ms(started: std::time::Instant) -> f64 {
        started.elapsed().as_secs_f64() * 1000.0
    }
    fn mib(bytes: i64) -> String {
        format!("{:.1} MiB", bytes as f64 / (1 << 20) as f64)
    }

    // Times first, without the profiler, which slows every allocation.
    let LargeHead {
        mut session,
        client,
        app,
        dir,
        ..
    } = large_head("quiet-review-parts-time").await;
    let step = std::time::Instant::now();
    session.publish_app(&app, false);
    let publish_kept = ms(step);
    let Ok(carry) = Box::new(session).quiet_carry() else {
        panic!("the session is quiet");
    };
    let reads = client.reads.lock().unwrap().len();
    let step = std::time::Instant::now();
    let mut session = Session::resume_quiet(carry);
    let restore = ms(step);
    assert_eq!(client.reads.lock().unwrap().len(), reads, "no runner read");
    assert!(session.index_ready && session.latest.is_some());
    // The first publish after the restore, in its two costly steps: the
    // projection built again from the index, then the apps' checkpoint of
    // every row; then the rest of the publish.
    let step = std::time::Instant::now();
    let update = session.app_update();
    let publish_build = ms(step);
    let step = std::time::Instant::now();
    session.app_save_snapshot();
    let publish_checkpoint = ms(step);
    app.update(update);
    let step = std::time::Instant::now();
    session.publish_app(&app, false);
    let publish_rest = ms(step);
    let publish_rebuilt = publish_build + publish_checkpoint + publish_rest;
    // For comparison, the restore without what the carry keeps: the
    // transcript read from the cut, the runner's view read back and the view
    // checks primed, as a restart's Setup and first view do.
    let Ok(carry) = Box::new(session).quiet_carry() else {
        panic!("the resumed session is quiet");
    };
    let mut session = Session::resume_quiet(carry);
    session.index = Index::starting_at(session.cut.unwrap_or(1));
    session.view_validation = Default::default();
    let carried = session.latest.take().map(|view| view.applied());
    session.latest_unknown = true;
    let step = std::time::Instant::now();
    session.index_ready = session.read_until(&client, None, true).await;
    let restore_read = ms(step);
    let step = std::time::Instant::now();
    session.adopt_runner_view(&client).await;
    let restore_view = ms(step);
    assert_eq!(session.latest.as_ref().map(View::applied), carried);
    let step = std::time::Instant::now();
    if let Some(view) = &session.latest {
        session.view_validation.prime(session.index.entries(), view);
    }
    let prime = ms(step);
    drop(session);
    let _ = std::fs::remove_dir_all(&dir);
    eprintln!(
        "large head restore, ms: as delivered (summaries and decisions from the stores, no \
         runner read) {restore:.1}; first app publish after the restore {publish_rebuilt:.1} \
         (projection built {publish_build:.1}, checkpoint of every row {publish_checkpoint:.1}, \
         the rest {publish_rest:.1}), an idle session's publish {publish_kept:.1}; for \
         comparison, what the carry saves: transcript read and index {restore_read:.1}, \
         runner's view read back {restore_view:.1}, view checks primed {prime:.1}"
    );

    // Bytes, with the profiler.
    let _profiler = dhat::Profiler::builder().testing().build();
    let live = || dhat::HeapStats::get().curr_bytes as i64;
    let LargeHead {
        mut session, app, ..
    } = large_head("quiet-review-parts-bytes").await;
    let key = session.key().clone();
    // A read goes through the apps' replica after every update sent before
    // it, so the replica no longer holds rows a dropped part shares.
    let sync = |app: &crate::app_read::AppRead| {
        let app = app.clone();
        let key = key.clone();
        async move {
            let _ = app
                .read(
                    "session_data.read",
                    serde_json::json!({"session": key, "section": "meta"}),
                )
                .await;
        }
    };
    sync(&app).await;
    // The replica's snapshot of the session, which a free releases.
    let before = live();
    app.forget_session(&key, false);
    sync(&app).await;
    let replica_bytes = before - live();
    let view = session.latest.clone().expect("the head's view");
    // The view checks' parts, by what copies of what each one holds cost:
    // the inserted messages, every edit with its size, and the first four
    // edits with their hash states.
    let before = live();
    let inserts: Vec<EditOp> = view
        .edits
        .iter()
        .filter(|edit| matches!(edit.op, EditOp::Insert { .. }))
        .map(|edit| edit.op.clone())
        .collect();
    let inserts_bytes = live() - before;
    drop(inserts);
    let before = live();
    let sizes: Vec<(cortexkit_role_compaction::view::Edit, usize)> =
        view.edits.iter().map(|edit| (edit.clone(), 0)).collect();
    let sizes_bytes = live() - before;
    drop(sizes);
    let before = live();
    let prefix: Vec<(cortexkit_role_compaction::view::Edit, sha2::Sha256)> = view
        .edits
        .iter()
        .take(4)
        .map(|edit| (edit.clone(), <sha2::Sha256 as sha2::Digest>::new()))
        .collect();
    let prefix_bytes = live() - before;
    drop(prefix);
    drop(view);
    let mut freed = |part: &str, drop_part: &mut dyn FnMut(&mut Session)| {
        let before = live();
        drop_part(&mut session);
        let bytes = before - live();
        (part.to_owned(), bytes)
    };
    let parts = vec![
        freed("view checks (inserts, hash_prefix, wire_sizes)", &mut |s| {
            s.view_validation = Default::default();
        }),
        freed("transcript index", &mut |s| s.index = Index::default()),
        freed("summaries (rows; head-summary cache)", &mut |s| {
            s.summaries.replace(Vec::new());
            s.head_summaries = None;
        }),
        freed("newest view", &mut |s| s.latest = None),
        freed("app projection and decisions", &mut |s| {
            s.app_projection = Default::default();
            s.app_decisions = Vec::new();
        }),
        freed("baseline and mural", &mut |s| {
            s.baseline = None;
            s.mural_image = None;
        }),
        freed("app state (stamps and counts, saved)", &mut |s| {
            s.app = Default::default();
        }),
        freed("summary scan cache", &mut |s| {
            s.scan_counts = Default::default();
        }),
        freed("summary trigger window", &mut |s| {
            s.due_window = Default::default();
        }),
        freed("image outputs and notes", &mut |s| {
            s.image_outputs = Default::default();
            s.notes = Default::default();
        }),
    ];
    let before = live();
    drop(session);
    let rest = before - live();

    // What the carry of the same head holds, part by part.
    let LargeHead { session, app, .. } = large_head("quiet-review-parts-carry").await;
    sync(&app).await;
    let before = live();
    let Ok(carry) = Box::new(session).quiet_carry() else {
        panic!("the session is quiet");
    };
    sync(&app).await;
    let shed = before - live();
    let mut session = *carry.0;
    let mut kept = |part: &str, drop_part: &mut dyn FnMut(&mut Session)| {
        let before = live();
        drop_part(&mut session);
        (part.to_owned(), before - live())
    };
    let carried = vec![
        kept("view checks", &mut |s| {
            s.view_validation = Default::default()
        }),
        kept("transcript index", &mut |s| s.index = Index::default()),
        kept("newest view", &mut |s| s.latest = None),
        kept("newest summary", &mut |s| s.summaries.replace(Vec::new())),
    ];
    let before = live();
    drop(session);
    let carry_rest = before - live();
    let carry_bytes = carried.iter().map(|(_, bytes)| bytes).sum::<i64>() + carry_rest;

    let mut table = String::from("large head, live bytes by part:\n");
    let total: i64 = parts.iter().map(|(_, bytes)| bytes).sum::<i64>() + rest;
    for (part, bytes) in &parts {
        table.push_str(&format!("  {part}: {}\n", mib(*bytes)));
    }
    table.push_str(&format!(
        "  everything else: {}\n  idle session in all: {}\n  the apps' replica snapshot, besides: \
         {}\n  of the view checks, by copies: inserts {}, wire_sizes {}, hash_prefix {}\n  freeing \
         drops {}; the carry holds {}:\n",
        mib(rest),
        mib(total),
        mib(replica_bytes),
        mib(inserts_bytes),
        mib(sizes_bytes),
        mib(prefix_bytes),
        mib(shed),
        mib(carry_bytes),
    ));
    for (part, bytes) in &carried {
        table.push_str(&format!("    {part}: {}\n", mib(*bytes)));
    }
    table.push_str(&format!("    everything else: {}\n", mib(carry_rest)));
    eprint!("{table}");
}
