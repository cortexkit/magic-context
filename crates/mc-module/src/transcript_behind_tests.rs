//! A transcript that no longer holds the messages a session's summaries end
//! on, with no revert reported, holds the session instead of forgetting the
//! summaries; a revert ck-mc missed still forgets the newest few (see
//! `IMPLICIT_FORGET_LIMIT`).

use super::*;
use cortexkit_role_compaction::ride::RideCause;

/// How many summaries the session has, each covering `SPAN` messages.
const SUMMARIES: u64 = 20;
const SPAN: u64 = 5;
/// The transcript: the summarized messages, then ten more.
const MESSAGES: u64 = SUMMARIES * SPAN + 10;
/// The name the hold and its release are logged under.
const HOLD_LOG: &str = "transcript_behind_summaries";
/// The oldest of the ten tool calls after the summarized messages: outside
/// the newest three, which are always protected.
const DROPPABLE: u64 = SUMMARIES * SPAN + 1;

/// Log output, for counting the hold's log lines.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Captured {
    fn install(&self) -> tracing::subscriber::DefaultGuard {
        let writer = self.clone();
        tracing::subscriber::set_default(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_writer(move || writer.clone())
                .finish(),
        )
    }

    /// Lines logged under the hold's name at `level`.
    fn lines(&self, level: &str) -> usize {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .filter(|line| line.contains(HOLD_LOG) && line.contains(level))
            .count()
    }
}

/// Messages 1 to `through`, named `m1`, `m2`, ...: a person's text up to the
/// last summarized message, then tool calls whose results a `ctx_reduce`
/// drop can remove.
fn transcript(through: u64) -> Vec<Entry> {
    (1..=through)
        .map(|n| {
            if n < DROPPABLE {
                return text(n, &format!("m{n}"));
            }
            let (call, path, output) = (format!("c{n}"), format!("f{n}"), format!("result {n}"));
            let mut part: Part = serde_json::from_value(serde_json::json!({
                "id":"p", "kind":"tool", "call_id":call, "name":"read", "input":{"path":path},
                "status":"completed", "output":output, "output_bytes":10, "digest":""
            }))
            .unwrap();
            part.tag = Some(n);
            Entry::new(n, format!("m{n}"), Role::Assistant, n, vec![part])
        })
        .collect()
}

/// Messages 1 to `kept` as they were, then replacements up to `through`:
/// what a revert after message `kept` leaves once new messages follow it.
fn reverted_after(kept: u64, through: u64) -> Vec<Entry> {
    let mut entries = transcript(kept);
    entries.extend((kept + 1..=through).map(|n| text(n, &format!("r{n}"))));
    entries
}

/// Two entries that share nothing with the session's history.
fn unrelated() -> Vec<Entry> {
    vec![text(1, "other-1"), text(2, "other-2")]
}

/// The state a held session must keep exactly as it was.
#[derive(Debug, PartialEq)]
struct Kept {
    summaries: Vec<StoredCompartment>,
    cut: Option<u64>,
    base: u64,
    baseline: Option<Arc<crate::summary::head::Baseline>>,
    latest: Option<(u64, String)>,
    unconfirmed: usize,
}

struct Fixture {
    session: Session,
    client: Client,
    route: Route,
    setup: SetupRequest,
    settings: Settings,
    log: Captured,
    _log: tracing::subscriber::DefaultGuard,
    dir: std::path::PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Fixture {
    /// A session whose 20 summaries cover messages 1 to 100 of a
    /// 110-message transcript, set up and showing them: the view it handed
    /// over cuts through message 100, and the runner has not confirmed it.
    async fn new(label: &str) -> Self {
        let log = Captured::default();
        let guard = log.install();
        let (mut session, client, route, setup, settings) = fixture();
        let dir = scratch(label);
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        for k in 1..=SUMMARIES {
            let (start, end) = ((k - 1) * SPAN + 1, k * SPAN);
            db.with_connection(|conn| {
                conn.execute(
                    "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', ?1, ?2, ?3, ?4, ?5, 'work', 'what happened', 'what happened', 1, 'mock')",
                    rusqlite::params![k as i64, start as i64, end as i64, format!("m{start}"), format!("m{end}")],
                )
                .map_err(|error| error.to_string())
            })
            .unwrap();
        }
        session.db = Some(Arc::new(db));
        session.features.summarizer = true;
        session.load_summaries();
        *client.entries.lock().unwrap() = transcript(MESSAGES);
        let mut fixture = Self {
            session,
            client,
            route,
            setup,
            settings,
            log,
            _log: guard,
            dir,
        };
        fixture.set_up().await;
        assert!(fixture.session.index_ready, "the first Setup read nothing");
        let (view, _) = fixture.session.build(&fixture.settings, None, false, None);
        fixture
            .session
            .accept(view.expect("a view showing the summaries"));
        assert_eq!(fixture.session.cut, Some(SUMMARIES * SPAN));
        fixture
    }

    /// The runner's transcript from now on.
    fn transcript(&self, entries: Vec<Entry>) {
        *self.client.entries.lock().unwrap() = entries;
    }

    fn newest(&self) -> Option<Cursor> {
        self.client.entries.lock().unwrap().last().map(cursor)
    }

    /// The runner's Setup, naming its newest entry.
    async fn set_up(&mut self) {
        let mut setup = self.setup.clone();
        setup.newest = self.newest();
        let features = self.session.features;
        self.session
            .setup(&self.client, &self.settings, &self.route, &setup, features)
            .await;
    }

    /// A notice naming the runner's newest entry and carrying its entries,
    /// with the prompt size `tokens` if set (99,000 of the 100,000-token
    /// window would make a ready session build and publish a view).
    async fn notice(&mut self, seq: u64, events: Vec<Event>, tokens: Option<u64>) {
        let mut request = notice(&self.session, seq, self.newest());
        request.entries = self.client.entries.lock().unwrap().clone();
        request.events = events;
        request.conditions.last_prompt_tokens = tokens;
        self.session
            .notice(&self.client, &self.settings, request)
            .await;
    }

    /// A ride for a request that would not fit, as the module handles it.
    async fn ride(&mut self) -> Option<View> {
        let mut ride = RideRequest::new(
            vec![RideCause::OverLimit],
            1_000,
            self.session.conditions.clone(),
        );
        ride.request_tokens = Some(99_000);
        self.session.before_ride(&self.client, &ride).await;
        self.session.ride(&self.settings, &ride)
    }

    fn kept(&self) -> Kept {
        Kept {
            summaries: self.session.summaries.to_vec(),
            cut: self.session.cut,
            base: self.session.index.base(),
            baseline: self.session.baseline.clone(),
            latest: self
                .session
                .latest
                .as_ref()
                .map(|view| (view.version, view.checksum.clone())),
            unconfirmed: self.session.unconfirmed.len(),
        }
    }

    /// The summary rows `context.db` holds for the session.
    fn rows(&self) -> usize {
        self.session
            .db
            .as_ref()
            .unwrap()
            .compartments("mock", "s1")
            .unwrap()
            .len()
    }

    fn offered(&self) -> usize {
        self.client.offered.lock().unwrap().len()
    }

    /// Held: the index is not ready, and the hold logged its ERROR line and
    /// has not logged its release.
    fn held(&self) -> bool {
        !self.session.index_ready && self.log.lines("ERROR") == 1 && self.log.lines("INFO") == 0
    }

    /// Ready, and a view can be built: a drop of message 101's tool result
    /// lands.
    fn builds_a_view(&mut self) -> bool {
        let mid = format!("m{DROPPABLE}");
        self.session.queued.insert((mid.clone(), "p".into()));
        self.session
            .build(&self.settings, None, false, None)
            .0
            .is_some_and(|view| {
                view.edits.iter().any(|edit| match &edit.op {
                    EditOp::Drop { mid: dropped, .. } => *dropped == mid,
                    EditOp::Replace { mid: replaced, .. } => *replaced == mid,
                    _ => false,
                })
            })
    }
}

#[tokio::test]
async fn a_setup_against_a_replaced_transcript_forgets_nothing_and_holds() {
    let mut fixture = Fixture::new("replaced").await;
    let kept = fixture.kept();
    let offered = fixture.offered();
    fixture.transcript(unrelated());
    fixture.set_up().await;
    assert_eq!(fixture.rows(), SUMMARIES as usize, "summary rows deleted");
    assert_eq!(fixture.kept(), kept, "a held session's state changed");
    assert_eq!(fixture.offered(), offered, "a held Setup offered a view");
    assert!(fixture.held(), "the session is not held");
    assert!(
        fixture
            .session
            .build(&fixture.settings, None, false, None)
            .0
            .is_none(),
        "a held session built a view"
    );
    let refused = fixture
        .session
        .tool(
            &fixture.client,
            &fixture.settings,
            "ctx_reduce",
            &serde_json::json!({"drop":"105"}),
        )
        .await;
    assert!(
        refused.is_err(),
        "a held session queued a drop: {refused:?}"
    );

    // The runner restores the transcript: the next Setup resumes the session
    // as it was, with no step from anyone.
    fixture.transcript(transcript(MESSAGES));
    fixture.set_up().await;
    assert!(
        fixture.session.index_ready,
        "the restored session read nothing"
    );
    assert!(!fixture.held());
    assert_eq!(fixture.log.lines("INFO"), 1, "the release was not logged");
    assert_eq!(fixture.rows(), SUMMARIES as usize);
    assert_eq!(fixture.session.summaries.len(), SUMMARIES as usize);
    assert_eq!(fixture.session.cut, kept.cut);
    assert_eq!(
        fixture.offered(),
        offered + 1,
        "the view handed over before the hold was not offered again"
    );
    assert!(
        fixture.builds_a_view(),
        "the resumed session builds no view"
    );
}

#[tokio::test]
async fn a_setup_against_half_the_transcript_forgets_nothing_and_holds() {
    let mut fixture = Fixture::new("halved").await;
    let kept = fixture.kept();
    // Summaries 1 to 10 still find their last message; 11 to 20 don't.
    fixture.transcript(transcript(SUMMARIES * SPAN / 2));
    fixture.set_up().await;
    assert_eq!(fixture.rows(), SUMMARIES as usize, "summary rows deleted");
    assert_eq!(fixture.kept(), kept);
    assert!(fixture.held());
}

#[tokio::test]
async fn a_setup_after_a_missed_revert_of_the_newest_two_summaries_forgets_them() {
    let mut fixture = Fixture::new("missed-revert").await;
    // The revert removed messages 91 to 100, and new ones followed.
    fixture.transcript(reverted_after(90, 95));
    fixture.set_up().await;
    assert_eq!(fixture.rows(), 18);
    assert_eq!(fixture.session.summaries.len(), 18);
    assert_eq!(fixture.session.cut, Some(90));
    assert!(fixture.session.index_ready, "the session is not ready");
    assert_eq!(fixture.log.lines("ERROR"), 0);
}

#[tokio::test]
async fn a_setup_forgets_three_failed_summaries_before_a_match_but_not_four() {
    let mut three = Fixture::new("three-failed").await;
    three.transcript(reverted_after(85, 95));
    three.set_up().await;
    assert_eq!(three.rows(), 17, "three summaries before a match");
    assert_eq!(three.session.summaries.len(), 17);
    assert!(three.session.index_ready);
    drop(three);

    let mut four = Fixture::new("four-failed").await;
    let kept = four.kept();
    four.transcript(reverted_after(80, 95));
    four.set_up().await;
    assert_eq!(
        four.rows(),
        SUMMARIES as usize,
        "four summaries before a match"
    );
    assert_eq!(four.kept(), kept);
    assert!(four.held());
}

#[tokio::test]
async fn a_reported_revert_ten_summaries_deep_still_forgets_ten() {
    let mut fixture = Fixture::new("reported-revert").await;
    fixture.transcript(reverted_after(50, 60));
    fixture
        .notice(1, vec![Event::TranscriptChanged { from_ordinal: 51 }], None)
        .await;
    assert_eq!(fixture.rows(), 10);
    assert_eq!(fixture.session.summaries.len(), 10);
    assert_eq!(fixture.session.cut, Some(50));
    assert_eq!(fixture.log.lines("ERROR"), 0);
}

#[tokio::test]
async fn a_held_session_keeps_everything_through_notices_and_rides() {
    let mut fixture = Fixture::new("held-notice").await;
    let kept = fixture.kept();
    let offered = fixture.offered();
    fixture.transcript(unrelated());
    let reads = fixture.client.reads.lock().unwrap().len();
    fixture.set_up().await;
    assert!(fixture.held());
    // Even a revert the runner reports waits until the transcript proves
    // the session again.
    fixture
        .notice(
            1,
            vec![Event::TranscriptChanged { from_ordinal: 1 }],
            Some(99_000),
        )
        .await;
    assert!(
        fixture.ride().await.is_none(),
        "a held session answered a ride"
    );
    fixture.notice(2, Vec::new(), Some(99_000)).await;
    assert_eq!(fixture.rows(), SUMMARIES as usize, "summary rows deleted");
    assert_eq!(fixture.kept(), kept);
    assert_eq!(fixture.offered(), offered, "a held session offered a view");
    assert!(fixture.held(), "a notice or ride released the hold");
    // Setup, two notices and a ride: four checks of at most four messages
    // each, read by id, and no other read.
    let reads = fixture.client.reads.lock().unwrap()[reads..].to_vec();
    assert!(
        reads.len() <= 4 * (IMPLICIT_FORGET_LIMIT + 1)
            && reads
                .iter()
                .all(|read| matches!(read.select, Select::Mids { .. })),
        "a held session read the transcript: {reads:?}"
    );
}

#[tokio::test]
async fn a_transcript_replaced_mid_session_holds_on_the_next_notice_and_recovers() {
    let mut fixture = Fixture::new("mid-session").await;
    let kept = fixture.kept();
    let offered = fixture.offered();
    fixture.transcript(unrelated());
    fixture.notice(1, Vec::new(), Some(99_000)).await;
    assert_eq!(fixture.rows(), SUMMARIES as usize, "summary rows deleted");
    assert_eq!(fixture.offered(), offered, "a held session offered a view");
    assert_eq!(fixture.kept(), kept, "a held session's state changed");
    assert!(fixture.held());

    // The runner restores the transcript before the session's next step.
    fixture.transcript(transcript(MESSAGES));
    fixture.notice(2, Vec::new(), None).await;
    assert!(
        fixture.session.index_ready,
        "the notice did not resume the session"
    );
    assert_eq!(fixture.log.lines("INFO"), 1, "the release was not logged");
    assert_eq!(fixture.rows(), SUMMARIES as usize);
    assert_eq!(fixture.session.summaries.len(), SUMMARIES as usize);
    assert_eq!(fixture.session.cut, kept.cut);
    assert!(
        fixture.builds_a_view(),
        "the resumed session builds no view"
    );
}

#[tokio::test]
async fn a_transcript_ending_before_the_cut_forgets_the_two_summaries_a_missed_revert_reached() {
    let mut fixture = Fixture::new("before-cut").await;
    // Messages 91 to 100 are gone and nothing followed them: the runner's
    // newest entry is before the cut, and summary 18 still ends on message 90.
    fixture.transcript(transcript(90));
    fixture.notice(1, Vec::new(), None).await;
    assert_eq!(fixture.rows(), 18);
    assert_eq!(fixture.session.summaries.len(), 18);
    assert_eq!(fixture.session.cut, Some(90));
    assert!(fixture.session.index_ready);
    assert_eq!(fixture.log.lines("ERROR"), 0);
}
