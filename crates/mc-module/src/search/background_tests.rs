use super::*;
use crate::client::{Child, ClientError};
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{Entry, Head, ReadPage, Role};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Default)]
struct Fake {
    entries: Arc<Mutex<Vec<Entry>>>,
    reads: Arc<AtomicUsize>,
    fail_read: Arc<AtomicUsize>,
    panic_read: Arc<AtomicUsize>,
    refuse_read: Arc<AtomicUsize>,
    active: Arc<Mutex<std::collections::HashSet<SessionRef>>>,
    pause: Arc<Mutex<Option<Arc<tokio::sync::Semaphore>>>>,
    started: Arc<Notify>,
}

fn entries(count: u64, prefix: &str) -> Vec<Entry> {
    (1..=count)
        .map(|n| {
            Entry::new(
                n,
                format!("{prefix}-{n}"),
                Role::User,
                n,
                vec![Part::new(
                    format!("p{n}"),
                    PartBody::Text {
                        text: format!("{prefix} searchable message {n}"),
                    },
                )],
            )
        })
        .collect()
}

impl Fake {
    fn cursor(&self) -> Option<Cursor> {
        self.entries
            .lock()
            .unwrap()
            .last()
            .map(|e| Cursor::new(e.ordinal, e.mid.clone(), e.digest.clone()))
    }
    fn mark(&self, from: Option<u64>) -> Mark {
        Mark {
            newest: self.cursor(),
            from,
            reconcile: None,
        }
    }
}

impl RunnerClient for Fake {
    async fn read(&self, key: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        assert!(
            self.active.lock().unwrap().insert(key.clone()),
            "overlapping reads for a session"
        );
        let pause = self.pause.lock().unwrap().clone();
        if let Some(pause) = pause {
            self.started.notify_one();
            pause.acquire().await.unwrap().forget();
        }
        let n = self.reads.fetch_add(1, Ordering::SeqCst) + 1;
        if self.refuse_read.load(Ordering::SeqCst) == n {
            self.active.lock().unwrap().remove(key);
            return Err(ClientError::refused(
                cortexkit_role_compaction::wire::codes::COMPACTION_NOT_PERMITTED,
                "provider is no longer allowed",
            ));
        }
        if self.panic_read.load(Ordering::SeqCst) == n {
            self.active.lock().unwrap().remove(key);
            panic!("injected runner read panic");
        }
        if self.fail_read.load(Ordering::SeqCst) == n {
            self.active.lock().unwrap().remove(key);
            return Err(ClientError::new("injected read failure"));
        }
        let Select::After {
            after_ordinal,
            limit,
        } = request.select
        else {
            panic!("not a compact catch-up read")
        };
        if let Some(limit) = limit {
            assert_eq!(limit, PAGE_ENTRIES);
        }
        let all = self.entries.lock().unwrap();
        let page: Vec<_> = all
            .iter()
            .skip(after_ordinal.unwrap_or(0) as usize)
            .take(limit.map_or(usize::MAX, |limit| limit as usize))
            .cloned()
            .collect();
        let mut head = Head::new();
        head.newest = all
            .last()
            .map(|e| Cursor::new(e.ordinal, e.mid.clone(), e.digest.clone()));
        self.active.lock().unwrap().remove(key);
        Ok(ReadPage::new(page, head))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        unreachable!()
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        unreachable!()
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        unreachable!()
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!()
    }
}

impl crate::routing::Router for Fake {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!()
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {
        unreachable!()
    }
}

#[tokio::test]
async fn a_stalled_background_read_does_not_hold_rides_pre_user_or_another_session() {
    use crate::{module::Module, pass::Settings, route::Route};
    use cortexkit_role_compaction::notice::{Conditions, NoticeRequest};
    use cortexkit_role_compaction::ride::{RideCause, RideRequest};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
    let f = Fixture::new(3);
    let module = Module::new(
        (*f.client).clone(),
        Settings::default(),
        Some(ContextDb::open(&f.path).unwrap()),
        None,
    );
    let other = SessionRef::new("runner", "pi", "other");
    let model = ModelRef::new("test", "model");
    let rules = ProviderRules::new(SignedParts::None, EditCost::Suffix);
    for key in [&f.key, &other] {
        let setup = SetupRequest::new(
            "head",
            model.clone(),
            1_000_000,
            128_000,
            rules.clone(),
            vec![],
            1,
        )
        .with_newest(f.client.cursor().unwrap());
        module
            .setup(
                Route {
                    session: key.clone(),
                    project: None,
                    workdir: None,
                    agent_id: None,
                },
                setup,
            )
            .unwrap();
        module.idle(key).await.unwrap();
    }
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *f.client.pause.lock().unwrap() = Some(pause.clone());
    let mut all = entries(4, "old");
    let added = all.pop().unwrap();
    f.client.entries.lock().unwrap().push(added.clone());
    let conditions: Conditions=serde_json::from_value(serde_json::json!({"model":model,"context_window":1000000,"output_reserve":128000,"rules":rules,"now":2,"last_prompt_tokens":436000})).unwrap();
    let mut request =
        NoticeRequest::new(1, conditions.clone()).with_newest(f.client.cursor().unwrap());
    request.entries = vec![added];
    module.notice(&f.key, request).unwrap();
    f.client.started.notified().await;
    tokio::time::timeout(Duration::from_millis(500), async {
        module.idle_foreground(&f.key).await.unwrap();
        for key in [&f.key, &other] {
            module
                .pre_user(key, "continue with the focused verification", 2)
                .await;
            module
                .ride(
                    key,
                    RideRequest::new(vec![RideCause::CacheExpired], 500, conditions.clone()),
                )
                .await
                .unwrap();
        }
    })
    .await
    .expect("foreground work waited for a stalled background runner read");
    *f.client.pause.lock().unwrap() = None;
    pause.add_permits(1);
    module.search_idle(&f.key).await.unwrap();
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    key: SessionRef,
    client: Arc<Fake>,
}

impl Fixture {
    fn new(count: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("context.db");
        ContextDb::create_for_tests(&path).unwrap();
        let client = Arc::new(Fake::default());
        *client.entries.lock().unwrap() = entries(count, "old");
        Self {
            _dir: dir,
            path,
            key: SessionRef::new("runner", "pi", "session"),
            client,
        }
    }
    fn worker(&self) -> Background {
        Background::new(self.client.clone(), self.path.clone())
    }
    fn assert_rows(&self, expected: usize) {
        let conn = Connection::open(&self.path).unwrap();
        let source: usize = conn
            .query_row("SELECT COUNT(*) FROM message_history_source", [], |r| {
                r.get(0)
            })
            .unwrap();
        let fts: usize = conn
            .query_row("SELECT COUNT(*) FROM message_history_fts", [], |r| r.get(0))
            .unwrap();
        let distinct: usize = conn
            .query_row(
                "SELECT COUNT(DISTINCT message_ordinal) FROM message_history_fts",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!((source, fts, distinct), (expected, expected, expected));
        assert_eq!(
            super::super::messages::watermark(&conn, &self.key.session).unwrap(),
            expected as i64
        );
    }
}

#[tokio::test]
async fn coalesced_batches_fill_the_gap_in_order_without_duplicate_fts_rows() {
    let f = Fixture::new(1_201);
    let worker = f.worker();
    for _ in 0..100 {
        worker.mark(&f.key, f.client.mark(None));
    }
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(1_201);
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(1_201);
}

#[tokio::test]
async fn failed_batch_stays_dirty_and_the_next_notice_retries_it() {
    let f = Fixture::new(31);
    let worker = f.worker();
    f.client.fail_read.store(1, Ordering::SeqCst);
    worker.mark(&f.key, f.client.mark(None));
    assert!(worker
        .idle(&f.key)
        .await
        .unwrap_err()
        .contains("injected read failure"));
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(31);
}

#[tokio::test]
async fn a_panicked_batch_clears_running_and_the_next_mark_retries() {
    let f = Fixture::new(13);
    f.client.panic_read.store(1, Ordering::SeqCst);
    let worker = f.worker();
    worker.mark(&f.key, f.client.mark(None));
    let failed = tokio::time::timeout(Duration::from_secs(1), worker.idle(&f.key))
        .await
        .expect("panic left the indexer running forever");
    assert!(failed.unwrap_err().contains("search batch panicked"));
    assert!(!worker.shared.state.lock().unwrap().sessions[&f.key].running);
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(13);
}

#[tokio::test]
async fn dropping_a_session_guard_forgets_pending_state_and_stale_work_is_safe() {
    let f = Fixture::new(3);
    let worker = f.worker();
    let guard = worker.session_guard(f.key.clone());
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    assert!(worker
        .shared
        .state
        .lock()
        .unwrap()
        .sessions
        .contains_key(&f.key));
    drop(guard);
    assert!(!worker
        .shared
        .state
        .lock()
        .unwrap()
        .sessions
        .contains_key(&f.key));
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(3);
}

#[tokio::test]
async fn forgetting_inflight_work_cannot_overwrite_the_readded_sessions_state() {
    let f = Fixture::new(3);
    let worker = f.worker();
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *f.client.pause.lock().unwrap() = Some(pause.clone());
    worker.mark(&f.key, f.client.mark(None));
    f.client.started.notified().await;
    worker.forget(&f.key);
    worker.mark(&f.key, f.client.mark(None));
    *f.client.pause.lock().unwrap() = None;
    pause.add_permits(1);
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(3);
}

#[tokio::test]
async fn a_revert_removes_unmapped_fts_rows_even_when_the_source_rows_are_gone() {
    let f = Fixture::new(0);
    let conn = Connection::open(&f.path).unwrap();
    conn.execute_batch(
        "UPDATE message_fts_rowid_map_backfill_state SET completed=0,watermark_rowid=0;",
    )
    .unwrap();
    for ordinal in 1..=401 {
        conn.execute("INSERT INTO message_history_fts (session_id,message_ordinal,message_id,role,content) VALUES (?1,?2,?3,'user','legacy searchable text')",params![f.key.session,ordinal,format!("legacy-{ordinal}")]).unwrap();
    }
    let worker = f.worker();
    worker.mark(&f.key, f.client.mark(Some(1)));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(0);
}

#[tokio::test]
async fn a_suspended_session_posts_no_search_marks() {
    use crate::{module::Module, pass::Settings, route::Route};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
    let f = Fixture::new(3);
    let module = Module::new(
        (*f.client).clone(),
        Settings::default(),
        Some(ContextDb::open(&f.path).unwrap()),
        None,
    );
    let route = Route {
        session: f.key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    // A refused transcript read suspends compaction and must not independently
    // start a background retry on the very same permission refusal.
    f.client.refuse_read.store(1, Ordering::SeqCst);
    let setup = SetupRequest::new(
        "head",
        ModelRef::new("test", "model"),
        1_000_000,
        128_000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        vec![],
        1,
    )
    .with_newest(f.client.cursor().unwrap());
    module.setup(route, setup).unwrap();
    module.idle_foreground(&f.key).await.unwrap();
    module.search_idle(&f.key).await.unwrap();
    assert_eq!(
        f.client.reads.load(Ordering::SeqCst),
        1,
        "suspended Setup still posted background search work"
    );
}

#[tokio::test]
async fn not_wal_stays_dirty_and_only_foreground_open_establishes_wal() {
    let f = Fixture::new(13);
    let conn = Connection::open(&f.path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=DELETE;").unwrap();
    let worker = f.worker();
    for _ in 0..2 {
        worker.mark(&f.key, f.client.mark(None));
        assert!(worker
            .idle(&f.key)
            .await
            .unwrap_err()
            .contains("context_wal_required:"));
        assert_eq!(
            conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "delete"
        );
        assert!(worker.shared.state.lock().unwrap().sessions[&f.key].warned_non_wal);
        let rows: usize = conn
            .query_row("SELECT COUNT(*) FROM message_history_source", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
    }
    drop(conn);
    let foreground = ContextDb::open(&f.path).unwrap();
    foreground.with_connection(|conn| {
        assert_eq!(
            conn.pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        assert_eq!(
            conn.pragma_query_value(None, "synchronous", |r| r.get::<_, u32>(0))
                .unwrap(),
            1
        );
    });
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(13);
}

#[tokio::test]
async fn failed_database_write_retries_without_advancing_the_watermark() {
    let f = Fixture::new(17);
    let worker = f.worker();
    let locked = Connection::open(&f.path).unwrap();
    locked.execute_batch("BEGIN IMMEDIATE;").unwrap();
    worker.mark(&f.key, f.client.mark(None));
    assert!(worker.idle(&f.key).await.is_err());
    locked.execute_batch("ROLLBACK;").unwrap();
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(17);
}

#[tokio::test]
async fn restart_resumes_a_partially_committed_gap_without_duplicates() {
    let f = Fixture::new(501);
    let worker = f.worker();
    f.client.fail_read.store(2, Ordering::SeqCst);
    worker.mark(&f.key, f.client.mark(None));
    assert!(worker.idle(&f.key).await.is_err());
    f.assert_rows(200);
    drop(worker);
    let restarted = f.worker();
    restarted.mark(&f.key, f.client.mark(None));
    restarted.idle(&f.key).await.unwrap();
    f.assert_rows(501);
}

#[tokio::test]
async fn revert_and_replacement_remove_stale_rows_and_restart_detects_a_lost_revert() {
    for lost_event in [false, true] {
        let f = Fixture::new(501);
        let worker = f.worker();
        worker.mark(&f.key, f.client.mark(None));
        worker.idle(&f.key).await.unwrap();
        drop(worker);
        let mut replacement = entries(150, "new");
        replacement[..100].clone_from_slice(&entries(100, "old"));
        *f.client.entries.lock().unwrap() = replacement;
        let restarted = f.worker();
        restarted.mark(&f.key, f.client.mark((!lost_event).then_some(101)));
        restarted.idle(&f.key).await.unwrap();
        f.assert_rows(150);
        let conn = Connection::open(&f.path).unwrap();
        let stale: usize = conn.query_row("SELECT COUNT(*) FROM message_history_source WHERE message_ordinal>100 AND message_id LIKE 'old-%'", [], |r|r.get(0)).unwrap();
        assert_eq!(stale, 0);
    }
}

#[tokio::test]
async fn an_inflight_read_coalesces_a_replacement_notice_without_losing_its_floor() {
    let f = Fixture::new(501);
    let worker = f.worker();
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    let pause = Arc::new(tokio::sync::Semaphore::new(0));
    *f.client.pause.lock().unwrap() = Some(pause.clone());
    worker.mark(&f.key, f.client.mark(None));
    f.client.started.notified().await;
    let mut replacement = entries(150, "new");
    replacement[..100].clone_from_slice(&entries(100, "old"));
    *f.client.entries.lock().unwrap() = replacement;
    for _ in 0..20 {
        worker.mark(&f.key, f.client.mark(Some(101)));
    }
    *f.client.pause.lock().unwrap() = None;
    pause.add_permits(1);
    worker.idle(&f.key).await.unwrap();
    f.assert_rows(150);
}

#[tokio::test]
async fn restart_finishes_a_failed_chunked_revert_from_its_durable_dirty_floor() {
    let f = Fixture::new(501);
    let worker = f.worker();
    worker.mark(&f.key, f.client.mark(None));
    worker.idle(&f.key).await.unwrap();
    let mut replacement = entries(150, "new");
    replacement[..100].clone_from_slice(&entries(100, "old"));
    *f.client.entries.lock().unwrap() = replacement;
    let conn = Connection::open(&f.path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_second_delete_chunk BEFORE DELETE ON message_history_source WHEN (SELECT COUNT(*) FROM message_history_source)<301 BEGIN SELECT RAISE(ABORT,'injected deletion failure'); END;").unwrap();
    worker.mark(&f.key, f.client.mark(Some(101)));
    assert!(worker.idle(&f.key).await.is_err());
    let floor: u64 = conn
        .query_row(
            "SELECT dirty_floor_ordinal FROM message_history_index WHERE session_id=?1",
            [&f.key.session],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(floor, 101);
    drop(worker);
    conn.execute_batch("DROP TRIGGER fail_second_delete_chunk;")
        .unwrap();
    let restarted = f.worker();
    restarted.mark(&f.key, f.client.mark(None));
    restarted.idle(&f.key).await.unwrap();
    f.assert_rows(150);
}

#[tokio::test]
async fn setup_reconciles_an_older_changed_tool_even_when_the_tip_id_did_not_change() {
    use crate::{module::Module, pass::Settings, route::Route};
    use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
    use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
    use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
    let f = Fixture::new(5);
    let tool = |output: &str| {
        let mut tool = ToolPart::new(
            "call",
            "read",
            serde_json::json!({"path":"a.rs"}),
            ToolStatus::Completed,
        );
        tool.output = Some(output.into());
        tool.output_bytes = Some(output.len() as u64);
        Entry::new(
            3,
            "tool",
            Role::Assistant,
            3,
            vec![Part::new("tool-part", PartBody::Tool(tool))],
        )
    };
    f.client.entries.lock().unwrap()[2] = tool("old result");
    let module = Module::new(
        (*f.client).clone(),
        Settings::default(),
        Some(ContextDb::open(&f.path).unwrap()),
        None,
    );
    let setup = || {
        SetupRequest::new(
            "head",
            ModelRef::new("test", "model"),
            1_000_000,
            128_000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            vec![],
            1,
        )
        .with_newest(f.client.cursor().unwrap())
    };
    let route = Route {
        session: f.key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    module.setup(route.clone(), setup()).unwrap();
    module.idle(&f.key).await.unwrap();
    let tip = f.client.cursor().unwrap();
    f.client.entries.lock().unwrap()[2] = tool("updated result after interrupted notice");
    assert_eq!(f.client.cursor().unwrap(), tip);
    module.setup(route, setup()).unwrap();
    module.idle(&f.key).await.unwrap();
    let conn = Connection::open(&f.path).unwrap();
    let digest:String=conn.query_row("SELECT source_version FROM message_history_source WHERE session_id=?1 AND message_ordinal=3",[&f.key.session],|r|r.get(0)).unwrap();
    assert_eq!(
        digest,
        f.client.entries.lock().unwrap()[2].digest,
        "stale source digest survived Setup reconciliation"
    );
    let source: usize = conn
        .query_row("SELECT COUNT(*) FROM message_history_source", [], |r| {
            r.get(0)
        })
        .unwrap();
    let fts: usize = conn
        .query_row("SELECT COUNT(*) FROM message_history_fts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        (source, fts),
        (5, 4),
        "tool-only output remains excluded from FTS, with one source row per entry"
    );
}
