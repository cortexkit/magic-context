use super::*;
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, Role};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::SendReply;
use std::collections::VecDeque;
use std::sync::Mutex;

#[path = "pass_decision_tests.rs"]
mod pass_decision_tests;

#[path = "session_count_tests.rs"]
mod count_tests;

#[derive(Default)]
struct Client {
    entries: Mutex<Vec<Entry>>,
    pages: Mutex<VecDeque<Result<ReadPage, crate::client::ClientError>>>,
    reads: Mutex<Vec<ReadRequest>>,
    offered: Mutex<Vec<View>>,
    refuse: Mutex<bool>,
    /// The refusal a refused view gets; `bad_since`, which names no part,
    /// when unset.
    refusal: Mutex<Option<ViewRefusal>>,
}

impl RunnerClient for Client {
    async fn read(
        &self,
        _: &SessionRef,
        request: ReadRequest,
    ) -> Result<ReadPage, crate::client::ClientError> {
        self.reads.lock().unwrap().push(request.clone());
        if let Some(page) = self.pages.lock().unwrap().pop_front() {
            return page;
        }
        let entries = self.entries.lock().unwrap();
        let mut head = Head::new();
        head.newest = entries.last().map(cursor);
        let selected = entries
            .iter()
            .filter(|entry| match &request.select {
                Select::After { after_ordinal, .. } => entry.ordinal > after_ordinal.unwrap_or(0),
                Select::Mids { mids } => mids.contains(&entry.mid),
                _ => false,
            })
            .cloned()
            .collect();
        Ok(ReadPage::new(selected, head))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, crate::client::ClientError> {
        self.offered.lock().unwrap().push(request.view);
        Ok(if *self.refuse.lock().unwrap() {
            ApplyViewAnswer::Refused {
                refusal: self
                    .refusal
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or(ViewRefusal::BadSince),
            }
        } else {
            ApplyViewAnswer::Accepted
        })
    }
    async fn applied_view(
        &self,
        _: &SessionRef,
    ) -> Result<AppliedViewAnswer, crate::client::ClientError> {
        Ok(AppliedViewAnswer::new())
    }
    async fn send(
        &self,
        _: &SessionRef,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        Ok(SendReply::new("pending"))
    }
    async fn send_child(
        &self,
        _: &crate::client::Child,
        _: SendRequest,
    ) -> Result<SendReply, crate::client::ClientError> {
        Err(crate::client::ClientError::new("no child"))
    }
    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: RunResultRequest,
    ) -> Result<RunResult, crate::client::ClientError> {
        Err(crate::client::ClientError::new("no child"))
    }
}

fn text(ordinal: u64, name: &str) -> Entry {
    let mut part = Part::new("p", PartBody::Text { text: name.into() });
    part.tag = Some(ordinal);
    Entry::new(ordinal, name, Role::User, ordinal, vec![part])
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

fn fixture() -> (Session, Client, Route, SetupRequest, Settings) {
    let route = Route {
        session: SessionRef::new("test", "mock", "s1"),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let request = SetupRequest::new(
        crate::catalog::Preset::Worker.as_str(),
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let features = Features {
        ctx_keep: true,
        ..Features::NONE
    };
    let session = Session::new(&route, &request, features, None);
    let client = Client::default();
    let settings = Settings {
        protected_tokens: Some(0),
        ..Settings::default()
    };
    (session, client, route, request, settings)
}

fn notice(session: &Session, seq: u64, newest: Option<Cursor>) -> NoticeRequest {
    let mut request = NoticeRequest::new(seq, session.conditions.clone());
    request.newest = newest;
    request
}

#[tokio::test]
async fn lifecycle_notice_divergence_reads_again_from_the_cut() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    session.index.extend(entries.clone());
    let mut replacement = entries;
    replacement[1] = text(2, "replacement");
    *client.entries.lock().unwrap() = replacement.clone();
    let mut request = notice(&session, 1, replacement.last().map(cursor));
    request.entries = vec![replacement[1].clone()];
    session.notice(&client, &settings, request).await;
    assert_eq!(session.index.entries()[1].mid, "replacement");
    assert!(matches!(
        client.reads.lock().unwrap()[0].select,
        Select::After {
            after_ordinal: None,
            ..
        }
    ));
}

#[tokio::test]
async fn lifecycle_failed_catchup_preserves_held_work_and_publishes_nothing() {
    let (mut session, client, _, _, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    session.index.extend(entries.clone());
    session.queued.insert(("a".into(), "p".into()));
    session.pending_keep = Some(BTreeSet::from([("missing".into(), "p".into())]));
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::new("read unavailable")));
    let mut request = notice(&session, 1, Some(cursor(&text(4, "d"))));
    request.conditions.last_prompt_tokens = Some(90_000);
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "a failed catch-up published a view"
    );
    assert!(session.queued.contains(&("a".into(), "p".into())));
    assert!(session.pending_keep.is_some());
    *client.entries.lock().unwrap() = entries;
    let request = notice(
        &session,
        2,
        client.entries.lock().unwrap().last().map(cursor),
    );
    session.notice(&client, &settings, request).await;
    assert!(session.pending_keep.is_none());
}

#[tokio::test]
async fn lifecycle_second_divergence_stops_the_pass() {
    let (mut session, client, _, _, settings) = fixture();
    session.index.extend(vec![text(1, "a"), text(2, "b")]);
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    for entries in [vec![text(1, "replacement")], vec![text(3, "c")]] {
        let mut head = Head::new();
        head.newest = Some(cursor(&text(3, "c")));
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(entries, head)));
    }
    let request = notice(&session, 1, Some(cursor(&text(4, "d"))));
    session.notice(&client, &settings, request).await;
    assert!(client.offered.lock().unwrap().is_empty());
    assert!(
        session.pending_keep.is_some(),
        "stopped catch-up consumed held work"
    );
    assert_eq!(client.reads.lock().unwrap().len(), 2);
}

#[test]
fn lifecycle_forget_missing_filters_keep_and_drops_an_empty_list() {
    let (mut session, _, _, _, _) = fixture();
    session.index.extend(vec![text(1, "a")]);
    session.pending_keep = Some(BTreeSet::from([
        ("gone".into(), "p".into()),
        ("a".into(), "p".into()),
    ]));
    session.forget_missing();
    assert_eq!(
        session.pending_keep,
        Some(BTreeSet::from([("a".into(), "p".into())]))
    );
    session.index.truncate(1);
    session.forget_missing();
    assert!(session.pending_keep.is_none());
}

#[test]
fn lifecycle_pending_keep_survives_serialization() {
    let (mut session, _, _, _, _) = fixture();
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(serde_json::from_slice(&bytes).unwrap());
    assert_eq!(restored.pending_keep, session.pending_keep);
}

#[test]
fn lifecycle_restored_worker_keeps_its_catalog_tool_policy() {
    let (mut session, _, _, _, _) = fixture();
    session.preset = crate::catalog::Preset::Worker;
    let (mut restored, _, _, _, _) = fixture();
    restored.preset = crate::catalog::Preset::Head;
    restored.restore(session.durable());
    let config = crate::config::Config::from(Settings::default()).catalog_config(None);
    assert!(
        restored.serves_tool("ctx_keep", &config),
        "restoring a worker changed its catalog policy"
    );
}

#[test]
fn lifecycle_head_retry_survives_serialization() {
    let (mut session, _, _, _, _) = fixture();
    session.head_stale = true;
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let (mut restored, _, _, _, _) = fixture();
    restored.restore(serde_json::from_slice(&bytes).unwrap());
    assert!(restored.head_stale);
}

#[tokio::test]
async fn lifecycle_a_transcript_shorter_than_the_saved_cut_can_grow_again() {
    let (mut session, client, route, mut request, settings) = fixture();
    session.restore(crate::store::Durable {
        cut: Some(20),
        ..Default::default()
    });
    let entries: Vec<_> = (1..=5).map(|n| text(n, &format!("m{n}"))).collect();
    *client.entries.lock().unwrap() = entries.clone();
    request.newest = entries.last().map(cursor);
    session
        .setup(
            &client,
            &settings,
            &route,
            &request,
            Features {
                ctx_keep: true,
                ..Features::NONE
            },
        )
        .await;
    let mut request = notice(&session, 1, Some(cursor(&text(7, "m7"))));
    request.entries = vec![text(6, "m6"), text(7, "m7")];
    session.notice(&client, &settings, request).await;
    let answer = session
        .ctx_reduce(&client, &serde_json::json!({"drop":"6"}))
        .await
        .unwrap();
    assert!(
        session.queued.contains(&("m6".into(), "p".into())),
        "{answer}"
    );
    assert_eq!(session.cut, None);
}

#[tokio::test]
async fn lifecycle_a_second_shrink_below_the_cut_stops_catchup() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("shrinking-cut");
    with_summary(&mut session, &dir, "b");
    session.cut = Some(20);
    session.pending_keep = Some(BTreeSet::from([("a".into(), "p".into())]));
    for newest in [Some(cursor(&text(5, "m5"))), None] {
        let mut head = Head::new();
        head.newest = newest;
        client
            .pages
            .lock()
            .unwrap()
            .push_back(Ok(ReadPage::new(Vec::new(), head)));
    }
    let request = notice(&session, 1, Some(cursor(&text(5, "m5"))));
    session.notice(&client, &settings, request).await;
    assert!(
        session.pending_keep.is_some(),
        "a repeatedly shrinking transcript consumed held work"
    );
    assert!(client.offered.lock().unwrap().is_empty());
    assert_eq!(client.reads.lock().unwrap().len(), 2);
    std::fs::remove_dir_all(dir).unwrap();
}

fn scratch(label: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/scratch")
        .join(format!(
            "lifecycle-{label}-{}-{now}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn with_summary(session: &mut Session, dir: &std::path::Path, end: &str) {
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute("INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', 1, 1, 2, 'a', ?1, 'undone', 'undone history', 'undone history', 1, 'mock')", [end]).map_err(|e| e.to_string())
    }).unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
}

#[tokio::test]
async fn lifecycle_setup_reconciles_a_revert_acknowledged_before_a_crash() {
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("lost-revert");
    with_summary(&mut session, &dir, "removed");
    session.index.extend(vec![text(1, "a"), text(2, "removed")]);
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.unwrap());
    let durable = session.durable();
    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "replacement")];
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(
        restored.summaries.is_empty(),
        "Setup retained undone summaries"
    );
    assert!(restored
        .db
        .as_ref()
        .unwrap()
        .compartments("mock", "s1")
        .unwrap()
        .is_empty());
    assert!(restored.head_stale);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_setup_preserves_legacy_summaries_without_endpoint_metadata() {
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("legacy-summary");
    with_summary(&mut session, &dir, "");
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    request.newest = Some(cursor(&text(1, "a")));
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert_eq!(
        session.summaries.len(),
        1,
        "missing legacy endpoint metadata is not evidence of a revert"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_a_delayed_revert_preserves_summaries_of_the_replacement_branch() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("stale-revert");
    with_summary(&mut session, &dir, "replacement");
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "replacement")];
    session.index.extend(client.entries.lock().unwrap().clone());
    let mut request = notice(
        &session,
        1,
        client.entries.lock().unwrap().last().map(cursor),
    );
    request
        .events
        .push(Event::TranscriptChanged { from_ordinal: 2 });
    session.notice(&client, &settings, request).await;
    assert_eq!(session.summaries.len(), 1);
    assert_eq!(
        session
            .db
            .as_ref()
            .unwrap()
            .compartments("mock", "s1")
            .unwrap()
            .len(),
        1
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_refused_head_rebuild_remains_due_until_a_later_acceptance() {
    let (mut session, client, _, _, settings) = fixture();
    session.features.summarizer = true;
    session.index.extend(vec![text(1, "a")]);
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    session.head_stale = true;
    *client.refuse.lock().unwrap() = true;
    let request = notice(&session, 1, Some(cursor(&text(1, "a"))));
    session.notice(&client, &settings, request).await;
    assert!(session.head_stale, "a refused rebuild consumed the retry");
    *client.refuse.lock().unwrap() = false;
    let request = notice(&session, 2, Some(cursor(&text(1, "a"))));
    session.notice(&client, &settings, request).await;
    assert_eq!(client.offered.lock().unwrap().len(), 2);
    assert!(!session.head_stale);
}

#[test]
fn lifecycle_rolling_back_an_earlier_view_restores_a_later_head_retry() {
    let (mut session, _, _, _, settings) = fixture();
    session.features.summarizer = true;
    let (view, _) = session.build(&settings, None, false, None);
    session.accept(view.unwrap());
    session.head_stale = true;
    session.next_baseline = session.baseline.clone();
    session.accept(View::seal(2, Vec::new()));
    assert!(!session.head_stale);
    session.roll_back(1, false, None);
    assert!(
        session.head_stale,
        "rolling back a chain lost its later rebuild obligation"
    );
}

#[tokio::test]
async fn lifecycle_failed_write_ahead_save_never_hands_over_a_view() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("write-ahead");
    let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
    session.set_store(Some(Arc::new(store)));
    rusqlite::Connection::open(dir.join("mode3.db"))
        .unwrap()
        .execute("DROP TABLE sessions", [])
        .unwrap();
    session.features.summarizer = true;
    session.head_stale = true;
    let request = notice(&session, 1, None);
    session.notice(&client, &settings, request).await;
    assert!(
        client.offered.lock().unwrap().is_empty(),
        "view escaped a failed durable save"
    );
    assert!(session.head_stale);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_store_save_reports_failure_and_never_waits_on_a_writer() {
    let dir = scratch("locks");
    let store = crate::store::Store::open(&dir.join("mode3.db")).unwrap();
    let blocker = rusqlite::Connection::open(dir.join("mode3.db")).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let (session, _, _, _, _) = fixture();
    let start = std::time::Instant::now();
    let result = format!("{:?}", store.save(session.key(), &session.durable()));
    assert!(
        start.elapsed() < std::time::Duration::from_millis(100),
        "a locked store stalled its worker"
    );
    assert!(
        result.starts_with("Err("),
        "save swallowed its error: {result}"
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_context_writes_wait_briefly_for_an_external_writer() {
    let dir = scratch("context-locks");
    let path = dir.join("context.db");
    let db = ContextDb::create_for_tests(&path).unwrap();
    let blocker = rusqlite::Connection::open(&path).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let start = std::time::Instant::now();
    let held = db.with_connection(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE; ROLLBACK")
            .map_err(|error| error.to_string())
    });
    let waited = start.elapsed();
    assert!(held.is_err(), "a held write lock was not reported");
    // A collision waits a little, as the plugin's own writes do, instead
    // of failing at once; a stuck writer stalls the thread only that long.
    assert!(
        waited >= std::time::Duration::from_millis(200),
        "gave up after {waited:?}"
    );
    assert!(
        waited < std::time::Duration::from_secs(2),
        "a held lock stalled the worker for {waited:?}"
    );
    blocker.execute_batch("ROLLBACK").unwrap();
    assert!(db
        .with_connection(|conn| conn
            .execute_batch("BEGIN IMMEDIATE; ROLLBACK")
            .map_err(|error| error.to_string()))
        .is_ok());
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_refused_automatic_drops_are_not_offered_on_every_pass() {
    let (mut session, client, _, _, settings) = fixture();
    // The old output sits outside the protected tail: three newer calls, and
    // no token floor beyond them.
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    let tool_part = |id: &str, tag: u64, output_bytes: u64| -> Part {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
            "status":"completed", "output":"result", "output_bytes":output_bytes, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part
    };
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(
            2,
            "tool",
            Role::Assistant,
            2,
            vec![tool_part("p", 2, 40000)],
        ),
        text(3, "next"),
        Entry::new(
            4,
            "newer",
            Role::Assistant,
            4,
            vec![
                tool_part("q", 4, 10),
                tool_part("r", 5, 10),
                tool_part("s", 6, 10),
            ],
        ),
    ]);
    session.reclaim_bookmark = 2;
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the automatic age sweep selected the old output");
    assert!(session.next_covered.contains(&("tool".into(), "p".into())));
    session.publish(&client, view).await;
    let (again, _) = session.build(&settings, None, false, None);
    assert!(
        again.is_none(),
        "a refused automatic drop was immediately rebuilt"
    );
}

#[tokio::test]
async fn lifecycle_revert_removes_summary_rows_and_raw_search_rows() {
    let (mut session, client, _, _, settings) = fixture();
    let dir = scratch("search-revert");
    with_summary(&mut session, &dir, "removed");
    session.index.extend(vec![text(1, "a"), text(2, "removed")]);
    session.db.as_ref().unwrap().with_connection(|conn| {
        crate::search::messages::index(conn, "mock", "s1", session.index.entries()).unwrap()
    });
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    let mut request = notice(&session, 1, Some(cursor(&text(1, "a"))));
    request
        .events
        .push(Event::TranscriptChanged { from_ordinal: 2 });
    session.notice(&client, &settings, request).await;
    // Notice invalidates summary state immediately; raw search cleanup now
    // runs on the independent indexer and is fenced only for this assertion.
    let search =
        crate::search::background::Background::new(Arc::new(client), dir.join("context.db"));
    let key = session.key().clone();
    search.mark(&key, session.search_mark());
    search.idle(&key).await.unwrap();
    let db = session.db.as_ref().unwrap();
    assert!(db.compartments("mock", "s1").unwrap().is_empty());
    let removed: u64 = db.with_connection(|conn| conn.query_row("SELECT COUNT(*) FROM message_history_source WHERE session_id = 's1' AND message_id = 'removed'", [], |row| row.get(0))).unwrap();
    assert_eq!(removed, 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn lifecycle_the_index_keeps_compact_sizes_tags_and_full_checksums() {
    use cortexkit_role_compaction::part::{Seal, ToolPart, ToolStatus};
    let mut transcript = mc_mock_runner::transcript::Transcript::new(40);
    transcript.append(
        Role::Assistant,
        None,
        vec![
            (
                Seal::None,
                PartBody::Text {
                    text: "the full reply".into(),
                },
            ),
            (
                Seal::None,
                PartBody::Tool(ToolPart::new(
                    "c",
                    "read",
                    serde_json::json!({"path":"file.rs"}),
                    ToolStatus::Running,
                )),
            ),
        ],
        None,
        None,
        1,
    );
    transcript
        .complete_tool(
            "c",
            ToolStatus::Completed,
            "output bytes".into(),
            vec![],
            vec![],
        )
        .unwrap();
    let (compact, _) = transcript
        .read(
            &Select::After {
                after_ordinal: None,
                limit: None,
            },
            Detail::Compact,
            None,
        )
        .unwrap();
    let mut index = Index::default();
    assert_eq!(index.extend(compact), Extend::Continued);
    let held = &index.entries()[0];
    assert_eq!(held.digest, transcript.entries()[0].digest);
    assert!(matches!(&held.parts[0].body, PartBody::Text {text} if text == "the full reply"));
    assert_eq!(held.parts[0].tag, Some(41));
    let PartBody::Tool(tool) = &held.parts[1].body else {
        panic!("missing tool")
    };
    assert_eq!(tool.input, serde_json::json!({"path":"file.rs"}));
    assert_eq!(tool.output, None);
    assert_eq!(tool.output_bytes, Some(12));
    assert_eq!(
        held.parts[1].digest,
        transcript.entries()[0].parts[1].digest
    );
    assert_eq!(held.parts[1].tag, Some(42));
}

#[tokio::test]
async fn a_time_marker_counts_from_when_the_previous_message_finished() {
    let marker = |completed_at: Option<u64>| async move {
        let (mut session, _, _, _, settings) = fixture();
        session.features.time_marker = true;
        let mut reply = text(1, "reply");
        reply.written_at = 0;
        reply.completed_at = completed_at;
        session.index.extend(vec![reply]);
        session
            .pre_user(&settings, "Carry on with the parser fix", 12 * 60_000)
            .await
            .prepend
    };
    // Written at minute 0 and finished at minute 10: the next message two
    // minutes later gets no marker.
    assert_eq!(marker(Some(10 * 60_000)).await, None);
    // Without a finish stamp the gap runs from when it was written.
    assert_eq!(marker(None).await.as_deref(), Some("<!-- +12m -->\n"));
}

#[test]
fn a_restarted_session_serves_the_same_mural_image_from_the_store() {
    let dir = scratch("mural-restart");
    let store = Arc::new(crate::store::Store::open(&dir.join("mode3.db")).unwrap());
    let (mut session, _, _, _, _) = fixture();
    session.set_store(Some(store.clone()));
    session.keep_mural(crate::mural::Mural {
        png: vec![0x89, b'P', b'N', b'G', 1, 2, 3],
        content_hash: "layout-1".into(),
        width: 1,
        height: 1,
        memory_ids: vec![1],
    });
    let before = session.mural_png("layout-1").expect("kept in memory");
    // A restarted process has nothing in memory: m[0] must still carry the
    // same bytes, from the store.
    let (mut restarted, _, _, _, _) = fixture();
    restarted.set_store(Some(store));
    assert_eq!(restarted.mural_png("layout-1"), Some(before));
    // A mural the store doesn't hold is left out, not invented.
    assert_eq!(restarted.mural_png("layout-2"), None);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_a_refused_provider_does_no_work_until_the_next_setup() {
    let (mut session, client, route, mut setup, settings) = fixture();
    let entries = vec![text(1, "a"), text(2, "b")];
    session.index.extend(entries.clone());
    *client.entries.lock().unwrap() = entries;
    // The runner's plan no longer names ck-mc as the session's provider.
    client
        .pages
        .lock()
        .unwrap()
        .push_back(Err(crate::client::ClientError::refused(
            cortexkit_role_compaction::wire::codes::COMPACTION_NOT_PERMITTED,
            "provider_mismatch",
        )));
    let request = notice(&session, 1, Some(cursor(&text(3, "c"))));
    session.notice(&client, &settings, request).await;
    assert!(session.suspended);

    // Later notices read nothing and publish nothing, even under pressure,
    // and a ride answers nothing.
    let reads = client.reads.lock().unwrap().len();
    let mut request = notice(&session, 2, Some(cursor(&text(3, "c"))));
    request.conditions.last_prompt_tokens = Some(99_000);
    let conditions = request.conditions.clone();
    session.notice(&client, &settings, request).await;
    let ride = RideRequest::new(vec![RideCause::CacheExpired], 1_000, conditions);
    assert!(session.ride(&settings, &ride).is_none());
    assert_eq!(client.reads.lock().unwrap().len(), reads);
    assert!(client.offered.lock().unwrap().is_empty());

    // The runner's next Setup lifts it, and work resumes from the state kept.
    *client.entries.lock().unwrap() = vec![text(1, "a"), text(2, "b"), text(3, "c")];
    setup.newest = Some(cursor(&text(3, "c")));
    session
        .setup(&client, &settings, &route, &setup, session.features)
        .await;
    assert!(!session.suspended);
    assert!(session.index_ready);
    assert_eq!(session.index.entries().len(), 3);
}

#[tokio::test]
async fn lifecycle_restored_state_ahead_of_context_db_moves_the_cut_back() {
    // A backup can pair a fresh mode3.db with an older context.db. Here the
    // saved state cuts through message d, behind a summary context.db no
    // longer has.
    let (mut session, client, route, mut request, settings) = fixture();
    let dir = scratch("store-ahead");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness)
             VALUES ('s1', 1, 1, 2, 'a', 'b', 'first', 'first part', 'first part', 1, 'mock'),
                    ('s1', 2, 3, 4, 'c', 'd', 'second', 'second part', 'second part', 1, 'mock');",
        )
        .map_err(|e| e.to_string())
    })
    .unwrap();
    session.db = Some(Arc::new(db));
    session.features.summarizer = true;
    session.load_summaries();
    let entries = vec![
        text(1, "a"),
        text(2, "b"),
        text(3, "c"),
        text(4, "d"),
        text(5, "e"),
    ];
    session.index.extend(entries.clone());
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.unwrap();
    session.accept(view.clone());
    assert_eq!(session.cut, Some(4));
    let durable = session.durable();
    session
        .db
        .as_ref()
        .unwrap()
        .with_connection(|conn| conn.execute("DELETE FROM compartments WHERE sequence = 2", []))
        .unwrap();

    let (mut restored, _, _, _, _) = fixture();
    restored.db = session.db.clone();
    restored.load_summaries();
    restored.restore(durable);
    assert_eq!(
        restored.cut,
        Some(2),
        "the cut follows context.db's summaries"
    );
    assert!(restored.baseline.is_none());
    assert!(restored.head_stale);

    // The runner still applies the old view; adopting it keeps ck-mc's cut,
    // and the next view moves the runner's cut back to message b.
    *client.entries.lock().unwrap() = entries;
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    restored.apply_cut(&view);
    assert_eq!(restored.cut, Some(2));
    restored
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    let notice = notice(&restored, 1, request.newest.clone());
    restored.notice(&client, &settings, notice).await;
    let offered = client.offered.lock().unwrap();
    let cut = offered.last().and_then(|view| {
        view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Cut { through } => Some(through.clone()),
            _ => None,
        })
    });
    assert_eq!(cut.as_deref(), Some("b"), "{offered:?}");
    drop(offered);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Two old outputs outside the protected tail, both picked by the age sweep.
fn two_old_outputs(session: &mut Session) {
    let tool_part = |id: &str, tag: u64, output_bytes: u64| -> Part {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
            "status":"completed", "output":"result", "output_bytes":output_bytes, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part
    };
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(
            2,
            "old",
            Role::Assistant,
            2,
            vec![tool_part("p", 2, 40000), tool_part("p2", 3, 40000)],
        ),
        text(3, "next"),
        Entry::new(
            4,
            "newer",
            Role::Assistant,
            4,
            vec![
                tool_part("q", 4, 10),
                tool_part("r", 5, 10),
                tool_part("s", 6, 10),
            ],
        ),
    ]);
    session.reclaim_bookmark = 3;
}

/// A refusal that names the part at fault sets aside only that part: the
/// view's other automatic drops are offered again on the next pass.
#[tokio::test]
async fn lifecycle_a_refusal_naming_a_part_sets_aside_only_that_part() {
    let (mut session, client, _, _, settings) = fixture();
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    two_old_outputs(&mut session);
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(ViewRefusal::StalePart {
        mid: "old".into(),
        part: "p".into(),
    });
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("both old outputs selected");
    assert!(session.next_covered.contains(&("old".into(), "p".into())));
    assert!(session.next_covered.contains(&("old".into(), "p2".into())));
    session.publish(&client, view).await;
    assert!(session.failed_parts.contains(&("old".into(), "p".into())));
    assert!(
        !session.failed_parts.contains(&("old".into(), "p2".into())),
        "a part the refusal did not name was set aside"
    );
}

/// A refused view puts the age-sweep bookmark back where it was, with
/// everything else it changed: an output first seen far behind on that pass
/// still survives one more rebuild.
#[tokio::test]
async fn lifecycle_a_refused_view_puts_the_age_sweep_bookmark_back() {
    let (mut session, client, _, _, settings) = fixture();
    let settings = Settings {
        protected_tokens: Some(0),
        ..settings
    };
    two_old_outputs(&mut session);
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, None);
    session.next_reclaim_bookmark = Some(5);
    session
        .publish(&client, view.expect("both old outputs selected"))
        .await;
    assert_eq!(session.reclaim_bookmark, 3);
}

fn output_part(id: &str, tag: u64) -> Part {
    let mut part: Part = serde_json::from_value(serde_json::json!({
        "id":id, "kind":"tool", "call_id":id, "name":"read", "input":{"path": id},
        "status":"completed", "output":"result", "output_bytes":40000, "digest":""
    }))
    .unwrap();
    part.tag = Some(tag);
    part
}

/// A fold for a changed head shape (a settings or window change) waits out a
/// heavy-thinking turn on a model that binds its thinking to the prefix, as
/// an execute pass does: re-rendering `m[0]` then would drop the thinking.
#[test]
fn lifecycle_a_shape_fold_waits_out_a_heavy_thinking_turn() {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    session.conditions.last_prompt_tokens = Some(30_000);
    let reasoning: Part = serde_json::from_value(serde_json::json!({
        "id":"r", "kind":"reasoning", "text_bytes":400, "digest":""
    }))
    .unwrap();
    let mut thinking = Entry::new(
        2,
        "think",
        Role::Assistant,
        2,
        vec![reasoning, output_part("t", 2)],
    );
    thinking.usage =
        Some(cortexkit_role_compaction::read::StepUsage::default().with_reasoning_tokens(2_000));
    session.index.extend(vec![text(1, "task"), thinking]);
    let mut shape = session.head_shape(&settings);
    shape.memory_enabled = !shape.memory_enabled;
    session.baseline = Some(Baseline {
        shape: Some(shape),
        ..Baseline::default()
    });
    let pass = session.decide_notice(&settings);
    assert!(!pass.rebuild, "the shape fold rebuilt during the hold");
    assert!(!session.fold_due);
}

/// The force-band summary skip projects usage after the drops this pass can
/// land: a queued drop waiting in the protected tail frees nothing yet.
#[test]
fn lifecycle_drops_waiting_in_the_tail_free_nothing_in_the_projection() {
    let (mut session, _, _, _, settings) = fixture();
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(2, "tool", Role::Assistant, 2, vec![output_part("p", 2)]),
    ]);
    session.queued.insert(("tool".into(), "p".into()));
    assert_eq!(session.usage_after_drops(&settings, 0.9), None);
}

/// A `ctx_keep` whose view the runner refuses waits again: the model was
/// told everything else goes, so the next pass must still carry it out.
#[tokio::test]
async fn lifecycle_a_refused_keep_view_waits_again() {
    let (mut session, client, _, _, settings) = fixture();
    two_old_outputs(&mut session);
    let kept: BTreeSet<lanes::PartKey> = BTreeSet::new();
    *client.refuse.lock().unwrap() = true;
    let (view, _) = session.build(&settings, None, false, Some(&kept));
    session
        .publish(&client, view.expect("the keep drops both outputs"))
        .await;
    assert_eq!(session.pending_keep, Some(kept));
}
