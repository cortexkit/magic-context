//! Rides and their causes: which ones let a rebuild land.
//!
//! A ride whose causes only say the provider forgot its cache (expiry, a
//! chain reset, a tier or account switch, an unknown cause) permits nothing
//! by itself: resending the same bytes keeps signed thinking valid and the
//! re-read is paid either way. A ride whose request's bytes before the
//! conversation change (`surface_change`, `model_change`) folds the head and
//! lands everything, and `over_limit` keeps its own pressure handling.

use super::*;

/// The causes that only say the provider forgot its cache.
fn forgotten_causes() -> Vec<RideCause> {
    vec![
        RideCause::CacheExpired,
        RideCause::ChainReset,
        RideCause::TierChange,
        RideCause::AccountChange,
        RideCause::Unknown("provider_flush".into()),
    ]
}

fn ride(session: &Session, causes: Vec<RideCause>, prompt: u64) -> RideRequest {
    let mut conditions = session.conditions.clone();
    conditions.last_prompt_tokens = Some(prompt);
    RideRequest::new(causes, 1_000, conditions)
}

/// Below the execute threshold (64,350 of the fixture's 99,000 usable).
const BELOW: u64 = 20_000;
/// At the execute threshold, below the force band.
const EXECUTE: u64 = 70_000;

/// Whether the view drops or rewrites the named part, or drops its whole
/// message.
fn touches(view: &View, mid: &str, part: &str) -> bool {
    view.edits.iter().any(|edit| match &edit.op {
        EditOp::Drop { mid: m, part: None } => m == mid,
        EditOp::Drop {
            mid: m,
            part: Some(p),
        }
        | EditOp::Replace {
            mid: m, part: p, ..
        } => m == mid && p == part,
        _ => false,
    })
}

fn m0(view: &View) -> Option<EditOp> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Insert { message, .. } if message.id == head::M0_ID => Some(edit.op.clone()),
        _ => None,
    })
}

fn m1_text(view: &View) -> String {
    view.edits
        .iter()
        .find_map(|edit| match &edit.op {
            EditOp::Insert { message, .. } if message.id == head::M1_ID => {
                Some(message.texts.join("\n"))
            }
            _ => None,
        })
        .unwrap_or_default()
}

fn tools(ordinal: u64, mid: &str, parts: &[(&str, u64)]) -> Entry {
    Entry::new(
        ordinal,
        mid,
        Role::Assistant,
        ordinal,
        parts
            .iter()
            .map(|(id, tag)| output_part(id, *tag))
            .collect(),
    )
}

/// A worker with two large old outputs (`old`/`p`, `old`/`p2`) outside the
/// protected tail, and three newer calls inside it.
fn worker() -> (Session, Client, Settings) {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![
        text(1, "task"),
        tools(2, "old", &[("p", 10), ("p2", 11)]),
        text(3, "next"),
        tools(4, "newer", &[("q", 12), ("r", 13), ("s", 14)]),
        text(5, "go on"),
    ];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    session.index_ready = true;
    (session, client, settings)
}

/// A head whose served view shows one summary in `m[0]`, with a newer summary
/// published since and not yet shown: a fold would move it into `m[0]`.
/// Returns the session and the `m[0]` the runner was served.
fn head_with_a_newer_summary(dir: &std::path::Path) -> (Session, Settings, EditOp) {
    let (mut session, _, _, _, settings) = fixture();
    with_summary(&mut session, dir, "b");
    session.index.extend(vec![
        text(1, "a"),
        text(2, "b"),
        text(3, "c"),
        tools(4, "old", &[("p", 10), ("p2", 11)]),
        tools(5, "newer", &[("q", 12), ("r", 13), ("s", 14)]),
        text(6, "d"),
    ]);
    session.index_ready = true;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the first view renders the head");
    let served = m0(&view).expect("the head has m[0]");
    session.accept(view);
    assert!(!session.fold_due);
    session.db.as_ref().unwrap().with_connection(|conn| {
        conn.execute("INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', 2, 3, 3, 'c', 'c', 'newer', 'newer summary text', 'newer summary text', 2, 'mock')", [])
            .map_err(|e| e.to_string())
    }).unwrap();
    session.load_summaries();
    session.summary_unshown = true;
    (session, settings, served)
}

/// A ChatGPT chain reset below the threshold is no reason to rewrite: the
/// ride answers nothing and the model's queued drops keep waiting. At the
/// execute threshold the same ride is an execute pass like a notice's, and
/// they land.
#[test]
fn ride_a_chain_reset_below_the_threshold_answers_nothing_and_keeps_the_drops() {
    let (mut session, _, settings) = worker();
    session.queued.insert(("old".into(), "p".into()));
    let answer = session.ride(
        &settings,
        &ride(&session, vec![RideCause::ChainReset], BELOW),
    );
    assert!(
        answer.is_none(),
        "a chain reset below the threshold rewrote: {answer:?}"
    );
    assert!(session.queued.contains(&("old".into(), "p".into())));
    assert!(!session.fold_due);

    let view = session
        .ride(
            &settings,
            &ride(&session, vec![RideCause::ChainReset], EXECUTE),
        )
        .expect("an execute pass lands the queued drop");
    assert!(touches(&view, "old", "p"), "{view:?}");
}

/// An expired cache does not fold `m[0]` on a head: below the threshold the
/// ride answers nothing, and on an execute pass the head refreshes `m[1]`
/// with the newer summary while `m[0]` stays byte-identical.
#[test]
fn ride_an_expired_cache_never_folds_the_head() {
    let dir = scratch("ride-expiry-keeps-m0");
    let (mut session, settings, served) = head_with_a_newer_summary(&dir);
    let answer = session.ride(
        &settings,
        &ride(&session, vec![RideCause::CacheExpired], BELOW),
    );
    assert!(answer.is_none(), "an expiry rewrote the head: {answer:?}");
    assert!(!session.fold_due);

    let view = session
        .ride(
            &settings,
            &ride(&session, vec![RideCause::CacheExpired], EXECUTE),
        )
        .expect("an execute pass shows the newer summary");
    assert_eq!(m0(&view), Some(served), "the expiry ride folded m[0]");
    assert!(
        m1_text(&view).contains("newer summary text"),
        "{}",
        m1_text(&view)
    );
    std::fs::remove_dir_all(dir).unwrap();
}

/// A surface change rewrites the prefix anyway: the head folds the newer
/// summary into `m[0]` and the queued drop lands, below the threshold.
#[test]
fn ride_a_surface_change_folds_and_lands_queued_drops() {
    let dir = scratch("ride-surface-folds");
    let (mut session, settings, served) = head_with_a_newer_summary(&dir);
    session.queued.insert(("old".into(), "p".into()));
    let view = session
        .ride(
            &settings,
            &ride(&session, vec![RideCause::SurfaceChange], BELOW),
        )
        .expect("a surface change rewrites anyway");
    let folded = m0(&view).expect("the view carries m[0]");
    assert_ne!(folded, served, "the surface change did not fold m[0]");
    assert!(
        serde_json::to_string(&folded)
            .unwrap()
            .contains("newer summary text"),
        "{folded:?}"
    );
    assert!(touches(&view, "old", "p"), "{view:?}");
    session.accept(view);
    assert!(!session.queued.contains(&("old".into(), "p".into())));
    std::fs::remove_dir_all(dir).unwrap();
}

/// What one ride leaves behind, for comparing two rides.
#[derive(Debug, PartialEq)]
struct After {
    view: Option<View>,
    fold_due: bool,
    emergency_latched: bool,
    queued: BTreeSet<lanes::PartKey>,
}

fn after(session: &mut Session, settings: &Settings, causes: Vec<RideCause>) -> After {
    let request = ride(session, causes, 95_000).with_request_tokens(100_000);
    let view = session.ride(settings, &request);
    if let Some(view) = &view {
        session.accept(view.clone());
    }
    After {
        view,
        fold_due: session.fold_due,
        emergency_latched: session.emergency_latched,
        queued: session.queued.clone(),
    }
}

/// A forgotten cache adds nothing to an over-limit ride: `[over_limit, X]`
/// leaves the same view and state as `[over_limit]` for every such X. The
/// pressure work still lands, the head does not fold (that would invalidate
/// signed thinking, and the request fits without it), and a spent emergency
/// episode stays spent.
#[test]
fn ride_a_forgotten_cache_adds_nothing_to_an_over_limit_ride() {
    for cause in forgotten_causes() {
        // A head: the pressure work lands, and `m[0]` stays as served.
        let alone_dir = scratch("ride-over-limit-alone");
        let both_dir = scratch("ride-over-limit-both");
        let (mut alone, settings, served) = head_with_a_newer_summary(&alone_dir);
        let (mut both, _, _) = head_with_a_newer_summary(&both_dir);
        let expected = after(&mut alone, &settings, vec![RideCause::OverLimit]);
        let actual = after(
            &mut both,
            &settings,
            vec![RideCause::OverLimit, cause.clone()],
        );
        assert_eq!(actual, expected, "over_limit with {cause:?}");
        let view = actual
            .view
            .expect("the over-limit ride lands pressure work");
        assert!(
            touches(&view, "old", "p") || touches(&view, "old", "p2"),
            "no emergency drop with {cause:?}: {view:?}"
        );
        assert_eq!(m0(&view), Some(served), "{cause:?} folded m[0]");
        std::fs::remove_dir_all(alone_dir).unwrap();
        std::fs::remove_dir_all(both_dir).unwrap();

        // A worker whose spent emergency episode has nothing left to drop:
        // the forgotten cause must not rearm it.
        let latched = || {
            let (mut session, _, _, _, settings) = fixture();
            session.index.extend(vec![text(1, "task")]);
            session.index_ready = true;
            session.emergency_latched = true;
            (session, settings)
        };
        let (mut alone, settings) = latched();
        let (mut both, _) = latched();
        let expected = after(&mut alone, &settings, vec![RideCause::OverLimit]);
        let actual = after(
            &mut both,
            &settings,
            vec![RideCause::OverLimit, cause.clone()],
        );
        assert_eq!(actual, expected, "over_limit with {cause:?}");
        assert!(actual.emergency_latched, "{cause:?} rearmed the episode");
        assert!(!actual.fold_due, "{cause:?} left a fold due");
    }
}

/// `over_limit` next to a chain reset still lands the pressure work: the
/// emergency drop and the queued drops, whatever the usage.
#[test]
fn ride_over_limit_with_a_chain_reset_lands_the_pressure_work() {
    let (mut session, _, settings) = worker();
    session.queued.insert(("old".into(), "p2".into()));
    let request = ride(
        &session,
        vec![RideCause::OverLimit, RideCause::ChainReset],
        BELOW,
    )
    .with_request_tokens(100_000);
    let view = session
        .ride(&settings, &request)
        .expect("an over-limit request must shrink");
    assert!(touches(&view, "old", "p"), "no emergency drop: {view:?}");
    assert!(touches(&view, "old", "p2"), "queued drop held: {view:?}");
}

/// A `ctx_keep` waiting for the next notice is not lost on a ride that
/// answers nothing: it stays pending, and the next notice carries it out.
#[tokio::test]
async fn ride_a_pending_keep_survives_a_forgotten_cache_ride_and_lands_later() {
    let (mut session, client, settings) = worker();
    // The model's `ctx_keep` call: everything before it except the kept part
    // goes once the keep is carried out.
    let mut call: Part = serde_json::from_value(serde_json::json!({
        "id":"k", "kind":"tool", "call_id":"k", "name":"ctx_keep", "input":{"tags": "12"},
        "status":"completed", "output":"Keeping §12§", "output_bytes":12, "digest":""
    }))
    .unwrap();
    call.tag = Some(15);
    let call = Entry::new(6, "keep", Role::Assistant, 6, vec![call]);
    session.index.extend(vec![call.clone()]);
    client.entries.lock().unwrap().push(call);
    let kept: BTreeSet<lanes::PartKey> = BTreeSet::from([("newer".into(), "q".into())]);
    session.pending_keep = Some(kept.clone());
    for cause in forgotten_causes() {
        assert!(session
            .ride(&settings, &ride(&session, vec![cause.clone()], BELOW))
            .is_none());
        assert_eq!(
            session.pending_keep,
            Some(kept.clone()),
            "{cause:?} took the keep"
        );
    }
    assert!(client.offered.lock().unwrap().is_empty());

    let newest = client.entries.lock().unwrap().last().map(cursor);
    let request = notice(&session, 1, newest);
    session.notice(&client, &settings, request).await;
    assert!(session.pending_keep.is_none());
    let offered = client.offered.lock().unwrap();
    let view = offered.last().expect("the notice carried out the keep");
    assert!(touches(view, "old", "p"), "{view:?}");
    assert!(!touches(view, "newer", "q"), "{view:?}");
}

/// Each cause is classified by what it does to the coming request's bytes.
#[test]
fn ride_causes_are_classified_by_what_they_do_to_the_request() {
    use pass::RideCauseKind;
    for cause in forgotten_causes() {
        assert_eq!(
            pass::ride_cause_kind(&cause),
            RideCauseKind::Forgotten,
            "{cause:?}"
        );
    }
    for cause in [RideCause::SurfaceChange, RideCause::ModelChange] {
        assert_eq!(
            pass::ride_cause_kind(&cause),
            RideCauseKind::PrefixChanges,
            "{cause:?}"
        );
    }
    assert_eq!(
        pass::ride_cause_kind(&RideCause::OverLimit),
        RideCauseKind::OverLimit
    );
}
