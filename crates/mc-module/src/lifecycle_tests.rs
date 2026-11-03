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

#[derive(Default)]
struct Client {
    entries: Mutex<Vec<Entry>>,
    pages: Mutex<VecDeque<Result<ReadPage, crate::client::ClientError>>>,
    reads: Mutex<Vec<ReadRequest>>,
    offered: Mutex<Vec<View>>,
    refuse: Mutex<bool>,
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
                refusal: ViewRefusal::BadSince,
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
        Err(crate::client::ClientError("no child".into()))
    }
    async fn child_result(
        &self,
        _: &crate::client::Child,
        _: RunResultRequest,
    ) -> Result<RunResult, crate::client::ClientError> {
        Err(crate::client::ClientError("no child".into()))
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
        "test",
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
        .push_back(Err(crate::client::ClientError("read unavailable".into())));
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
    assert!(session.ctx_reduce(&serde_json::json!({"drop":"6"})).is_ok());
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
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/scratch")
        .join(format!(
            "lifecycle-{label}-{}-{}",
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
    restored.restore(durable);
    restored.load_summaries();
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
    session.roll_back(1, false);
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
fn lifecycle_context_writes_never_wait_on_an_external_writer() {
    let dir = scratch("context-locks");
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let timeout = db
        .with_connection(|conn| {
            conn.query_row("PRAGMA busy_timeout", [], |row| row.get::<_, u64>(0))
                .map_err(|e| e.to_string())
        })
        .unwrap();
    assert_eq!(
        timeout, 0,
        "shared context writes may not stall another session"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn lifecycle_refused_automatic_drops_are_not_offered_on_every_pass() {
    let (mut session, client, _, _, settings) = fixture();
    let mut tool: Part = serde_json::from_value(serde_json::json!({
        "id":"p", "kind":"tool", "call_id":"c", "name":"read", "input":{},
        "status":"completed", "output":"large result", "output_bytes":40000, "digest":""
    }))
    .unwrap();
    tool.tag = Some(2);
    session.index.extend(vec![
        text(1, "task"),
        Entry::new(2, "tool", Role::Assistant, 2, vec![tool]),
        text(3, "next"),
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
    session.update_search_index();
    *client.entries.lock().unwrap() = vec![text(1, "a")];
    let mut request = notice(&session, 1, Some(cursor(&text(1, "a"))));
    request
        .events
        .push(Event::TranscriptChanged { from_ordinal: 2 });
    session.notice(&client, &settings, request).await;
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
