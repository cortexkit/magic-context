//! Regression tests for properties ck-mc kept before its per-notice cost
//! work moved message search indexing to a background thread, stored large
//! history text by content digest in the version-4 `mode3.db`, and made
//! writable opens of `context.db` switch it to WAL.
//!
//! Each test states one such property. They drive the public `Module` API
//! and `Module::idle` only, which exist before and after that work, so the
//! same file runs against both versions of the code.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use cortexkit_role_compaction::notice::{Conditions, Event, NoticeRequest};
use cortexkit_role_compaction::part::{Part, PartBody};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, Select, SessionRef,
};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::module::Module;
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::routing::{RouteError, Router};
use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};

/// How long a step that needs no model or slow runner may take before the
/// test calls it stuck. Every step here finishes in milliseconds when sound.
const STEP: Duration = Duration::from_secs(10);

fn text_entry(ordinal: u64, mid: &str, text: &str) -> Entry {
    Entry::new(
        ordinal,
        mid.to_owned(),
        Role::User,
        ordinal,
        vec![Part::new(
            format!("{mid}-part"),
            PartBody::Text {
                text: text.to_owned(),
            },
        )],
    )
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

/// One runner request carried over the stand-in connection.
enum Call {
    Read(ReadRequest, oneshot::Sender<ReadPage>),
    Applied(oneshot::Sender<AppliedViewAnswer>),
    Apply(oneshot::Sender<ApplyViewAnswer>),
}

#[derive(Default)]
struct RunnerState {
    entries: Vec<Entry>,
    /// The sending half of the live connection, or `None` while disconnected.
    connection: Option<mpsc::UnboundedSender<Call>>,
    /// The thread each connection was opened from, for failure messages.
    connected_from: Vec<String>,
}

/// A runner client with the connection model of production's
/// `SubcRunnerClient`: the daemon connection is opened on first use, and
/// again by the first call after it drops, and its I/O task is started with
/// `tokio::spawn` on whatever runtime that call runs on. In subc-client-rs
/// 0.33.0 that is `OnceCell::get_or_try_init(SubcConsumer::connect)` in
/// `transport.rs` and the inline reconnect in
/// `Shared::ensure_connected_for_call`, both of which reach
/// `tokio::spawn(reader_loop)` / `tokio::spawn(writer_loop)`.
#[derive(Clone, Default)]
struct Runner(Arc<Mutex<RunnerState>>);

impl Runner {
    fn with_entries(entries: Vec<Entry>) -> Self {
        let runner = Self::default();
        runner.0.lock().unwrap().entries = entries;
        runner
    }

    fn newest(&self) -> Option<Cursor> {
        self.0.lock().unwrap().entries.last().map(cursor)
    }

    fn push(&self, entry: Entry) {
        self.0.lock().unwrap().entries.push(entry);
    }

    fn replace(&self, entries: Vec<Entry>) {
        self.0.lock().unwrap().entries = entries;
    }

    /// The transport drops; the old I/O task ends with its channel.
    fn disconnect(&self) {
        self.0.lock().unwrap().connection = None;
    }

    fn connected_from(&self) -> Vec<String> {
        self.0.lock().unwrap().connected_from.clone()
    }

    fn connection(&self) -> mpsc::UnboundedSender<Call> {
        let mut state = self.0.lock().unwrap();
        if let Some(live) = &state.connection {
            return live.clone();
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<Call>();
        let shared = self.0.clone();
        tokio::spawn(async move {
            while let Some(call) = rx.recv().await {
                match call {
                    Call::Read(request, reply) => {
                        let page = page(&shared.lock().unwrap().entries, request);
                        let _ = reply.send(page);
                    }
                    Call::Applied(reply) => {
                        let _ = reply.send(AppliedViewAnswer::new());
                    }
                    Call::Apply(reply) => {
                        let _ = reply.send(ApplyViewAnswer::Accepted);
                    }
                }
            }
        });
        state.connected_from.push(
            std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_owned(),
        );
        state.connection = Some(tx.clone());
        tx
    }
}

fn page(entries: &[Entry], request: ReadRequest) -> ReadPage {
    let selected: Vec<Entry> = match request.select {
        Select::After {
            after_ordinal,
            limit,
        } => entries
            .iter()
            .filter(|entry| entry.ordinal > after_ordinal.unwrap_or(0))
            .take(limit.map_or(usize::MAX, |limit| limit as usize))
            .cloned()
            .collect(),
        Select::Mids { mids } => entries
            .iter()
            .filter(|entry| mids.contains(&entry.mid))
            .cloned()
            .collect(),
        other => panic!("unexpected read selector: {other:?}"),
    };
    let mut head = Head::new();
    head.newest = entries.last().map(cursor);
    ReadPage::new(selected, head)
}

fn closed() -> ClientError {
    ClientError::new("stand-in connection closed")
}

impl RunnerClient for Runner {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let (reply, answer) = oneshot::channel();
        self.connection()
            .send(Call::Read(request, reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        let (reply, answer) = oneshot::channel();
        self.connection()
            .send(Call::Apply(reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let (reply, answer) = oneshot::channel();
        self.connection()
            .send(Call::Applied(reply))
            .map_err(|_| closed())?;
        answer.await.map_err(|_| closed())
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no reminders in this test"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no summarizer runs in this test"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("no summarizer runs in this test"))
    }
}

impl Router for Runner {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        Err(RouteError {
            code: "routing_unavailable".into(),
            message: "no routing in this test".into(),
            detail: None,
        })
    }

    async fn report(&self, _: ReportRequest) {}
}

fn rules() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn model() -> ModelRef {
    ModelRef::new("test", "model")
}

fn route(key: &SessionRef) -> Route {
    Route {
        session: key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    }
}

fn setup_request(newest: Option<Cursor>) -> SetupRequest {
    let request = SetupRequest::new("head", model(), 1_000_000, 128_000, rules(), vec![], 1);
    match newest {
        Some(newest) => request.with_newest(newest),
        None => request,
    }
}

fn conditions(now: u64) -> Conditions {
    serde_json::from_value(serde_json::json!({
        "model": model(),
        "context_window": 1_000_000,
        "output_reserve": 128_000,
        "rules": rules(),
        "now": now,
        "last_prompt_tokens": 436_000,
    }))
    .unwrap()
}

/// A context.db with the fresh schema, opened the way ck-mc's foreground
/// opens it.
fn context_db(dir: &tempfile::TempDir) -> (std::path::PathBuf, ContextDb) {
    let path = dir.path().join("context.db");
    ContextDb::create_for_tests(&path).unwrap();
    let db = ContextDb::open(&path).unwrap();
    (path, db)
}

async fn settle(module: &Module<Runner>, key: &SessionRef, what: &str) {
    tokio::time::timeout(STEP, module.idle(key))
        .await
        .unwrap_or_else(|_| panic!("{what}: the session did not settle within {STEP:?}"))
        .unwrap();
}

/// Rule: background search indexing never blocks a runner call on a
/// session's worker, so a ride, the `pre_user` hook or a view handed to the
/// runner never waits for it. The background indexer runs its batches with
/// `runtime.block_on` on a private current-thread runtime
/// (search/background.rs, `Background::new`). When one of its runner reads
/// is the call that (re)opens the daemon connection, the connection's I/O
/// task is spawned on that private runtime, which only runs while a batch is
/// in flight. Every later runner call from a session worker then waits on
/// a task nothing polls. Before indexing moved to that thread, all runner
/// calls ran on the module's own runtime.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_runner_call_after_the_indexer_reopened_the_connection_completes() {
    let dir = tempfile::tempdir().unwrap();
    let (_, db) = context_db(&dir);
    let runner = Runner::with_entries(
        (1..=3)
            .map(|n| text_entry(n, &format!("m{n}"), &format!("searchable message {n}")))
            .collect(),
    );
    let module = Module::new(runner.clone(), Settings::default(), Some(db), None);
    let key = SessionRef::new("runner", "pi", "session");

    // Setup reads the transcript on the session worker: the connection is
    // opened on the module's runtime.
    module
        .setup(route(&key), setup_request(runner.newest()))
        .unwrap();
    settle(&module, &key, "setup").await;

    // The daemon connection drops. The next caller reopens it.
    runner.disconnect();

    // A notice that carries its new entry needs no runner call on the
    // session worker, so the indexer's catch-up read is the next caller.
    let added = text_entry(4, "m4", "searchable message 4");
    runner.push(added.clone());
    let mut first = NoticeRequest::new(1, conditions(2)).with_newest(runner.newest().unwrap());
    first.entries = vec![added];
    module.notice(&key, first).unwrap();
    settle(&module, &key, "notice with inline entries").await;

    // A notice that leaves its entries out makes the session worker read the
    // transcript from the runner.
    runner.push(text_entry(5, "m5", "searchable message 5"));
    let second = NoticeRequest::new(2, conditions(3)).with_newest(runner.newest().unwrap());
    module.notice(&key, second).unwrap();
    let finished = tokio::time::timeout(STEP, module.idle(&key)).await;
    assert!(
        finished.is_ok(),
        "a session worker's runner read never completed; the connection was \
         opened from threads {:?}: its I/O task runs on the background \
         indexer's private runtime, which is parked between batches",
        runner.connected_from()
    );
}

/// Rule: a revert removes every search row of the reverted messages, so
/// `ctx_search` never returns text from a branch that no longer exists.
/// Before indexing moved to the background thread,
/// `search::messages::forget_from` deleted `message_history_fts` rows by
/// session and ordinal. The background indexer's `truncate_chunk`
/// (search/background.rs) deletes FTS rows only through
/// `message_fts_rowid_map`, so an FTS row with no map entry survives. Such
/// rows are expected: rows written before the map existed are mapped only
/// when the plugin's global rowid backfill reaches them
/// (`deleteUnmappedMessageFtsRows` in the plugin's message-fts-rowid-map.ts
/// sweeps them for exactly this reason). ck-mc's message search reads
/// `message_history_fts` without the map when no date range is given, so
/// the reverted text stays searchable.
#[tokio::test]
async fn a_revert_removes_reverted_text_from_search_even_without_a_rowid_map_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (path, db) = context_db(&dir);
    let runner = Runner::with_entries(vec![
        text_entry(1, "m1", "first message"),
        text_entry(2, "m2", "second message"),
        text_entry(3, "m3-old", "zebra branch that will be reverted"),
    ]);
    let module = Module::new(runner.clone(), Settings::default(), Some(db), None);
    let key = SessionRef::new("runner", "pi", "session");
    module
        .setup(route(&key), setup_request(runner.newest()))
        .unwrap();
    // A notice carrying the newest entry again indexes the session on both
    // sides of the background-indexing change (before it, indexing ran only
    // on notices).
    let mut first = NoticeRequest::new(1, conditions(2)).with_newest(runner.newest().unwrap());
    first.entries = vec![text_entry(
        3,
        "m3-old",
        "zebra branch that will be reverted",
    )];
    module.notice(&key, first).unwrap();
    settle(&module, &key, "initial indexing").await;

    let conn = Connection::open(&path).unwrap();
    let zebra = |conn: &Connection| -> usize {
        conn.query_row(
            "SELECT COUNT(*) FROM message_history_fts
              WHERE session_id = 'session' AND message_history_fts MATCH 'content : zebra'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(zebra(&conn), 1, "the old branch was indexed");
    // The row predates the rowid map: the global backfill has not reached it.
    conn.execute_batch(
        "DELETE FROM message_fts_rowid_map WHERE session_id = 'session' AND message_ordinal = 3;
         INSERT OR REPLACE INTO message_fts_rowid_map_backfill_state (id, watermark_rowid, completed, updated_at)
           VALUES (1, 0, 0, 0);",
    )
    .unwrap();

    // The runner reverts message 3 and a new message takes its ordinal.
    let replacement = text_entry(3, "m3-new", "replacement message");
    runner.replace(vec![
        text_entry(1, "m1", "first message"),
        text_entry(2, "m2", "second message"),
        replacement.clone(),
    ]);
    let mut revert = NoticeRequest::new(2, conditions(3)).with_newest(cursor(&replacement));
    revert
        .events
        .push(Event::TranscriptChanged { from_ordinal: 3 });
    revert.entries = vec![replacement];
    module.notice(&key, revert).unwrap();
    settle(&module, &key, "revert").await;

    assert_eq!(
        zebra(&conn),
        0,
        "reverted text is still in message_history_fts after the revert was indexed"
    );
    let rows_for_three: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM message_history_fts
              WHERE session_id = 'session' AND CAST(message_ordinal AS INTEGER) = 3",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows_for_three, 1, "ordinal 3 has more than one FTS row");
}

/// Rule: indexing work does not grow with session length when nothing
/// changed. A Setup for a transcript the index already holds, unchanged,
/// rewrites no search rows. With background indexing every Setup marks the
/// session dirty from the start of its held window (`Session::setup` sets
/// `search_dirty_from` to `index.base()`, which is 1 for a session without
/// a summary), and the indexer deletes and re-inserts every row from there.
/// Until it finishes, `ctx_search` finds none of those messages.
#[tokio::test]
async fn a_repeated_setup_over_an_unchanged_transcript_rewrites_no_search_rows() {
    let dir = tempfile::tempdir().unwrap();
    let (path, db) = context_db(&dir);
    let entries: Vec<Entry> = (1..=40)
        .map(|n| text_entry(n, &format!("m{n}"), &format!("searchable message {n}")))
        .collect();
    let runner = Runner::with_entries(entries.clone());
    let module = Module::new(runner.clone(), Settings::default(), Some(db), None);
    let key = SessionRef::new("runner", "pi", "session");
    module
        .setup(route(&key), setup_request(runner.newest()))
        .unwrap();
    let mut first = NoticeRequest::new(1, conditions(2)).with_newest(runner.newest().unwrap());
    first.entries = vec![entries.last().unwrap().clone()];
    module.notice(&key, first).unwrap();
    settle(&module, &key, "initial indexing").await;

    let conn = Connection::open(&path).unwrap();
    let indexed: usize = conn
        .query_row(
            "SELECT COUNT(*) FROM message_history_source WHERE session_id = 'session'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 40, "the session was indexed");
    conn.execute_batch(
        "CREATE TABLE witness_deleted (n INTEGER);
         CREATE TRIGGER witness_count_deletes AFTER DELETE ON message_history_source
           BEGIN INSERT INTO witness_deleted VALUES (old.message_ordinal); END;",
    )
    .unwrap();

    // The runner calls Setup again (after its own restart, or when it lost
    // ck-mc); the transcript is unchanged.
    module
        .setup(route(&key), setup_request(runner.newest()))
        .unwrap();
    settle(&module, &key, "repeated setup").await;

    let deleted: usize = conn
        .query_row("SELECT COUNT(*) FROM witness_deleted", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        deleted, 0,
        "a Setup over an unchanged transcript deleted {deleted} search rows to re-insert them"
    );
}

/// Rule (store migration): a version-3 store opens under the version-4
/// build whenever the version-3 build could open it. The version-3 build
/// opened a store holding a row it could not decode and treated only that
/// session as having no saved state (`Store::load` returned `None`). The
/// version-4 migration (`store_text::migrate`) parses every row first and
/// fails the whole open on the first undecodable one, so `ck-mc` refuses to
/// start (`main.rs`: `Store::open(..)?`) and every session it serves goes
/// unmanaged because of one row.
#[test]
fn a_version_three_store_with_one_undecodable_row_still_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mode3.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (
                 runner TEXT NOT NULL, harness TEXT NOT NULL, session TEXT NOT NULL,
                 state TEXT NOT NULL, PRIMARY KEY (runner, harness, session));
             INSERT INTO sessions VALUES ('runner', 'pi', 'good', '{}');
             INSERT INTO sessions VALUES ('runner', 'pi', 'torn', '{\"version\": 3, \"queued\": [');
             PRAGMA user_version = 3;",
        )
        .unwrap();
    }
    let store = mc_module::store::Store::open(&path);
    assert!(
        store.is_ok(),
        "one undecodable session row blocks the whole store: {:?}",
        store.err()
    );
}

/// The journal-mode switch on `context.db` (`ContextDb::open`, which now runs
/// `PRAGMA journal_mode=WAL`). Moving a rollback-journal file to WAL needs
/// an exclusive lock, so while any other process holds even a read
/// transaction the switch fails after the 250 ms busy timeout, and the open
/// fails with it: `ck-mc` does not start. Before `ContextDb::open` made the
/// switch it left the journal mode alone and succeeded. Only a file still in
/// rollback mode is affected; the plugin switches `context.db` to WAL on
/// every writable open, so a store any current plugin host has opened is
/// already WAL (the control test below).
#[test]
fn a_rollback_journal_context_db_opens_while_another_process_reads_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    drop(ContextDb::create_for_tests(&path).unwrap());
    let reader = Connection::open(&path).unwrap();
    let mode: String = reader
        .query_row("PRAGMA journal_mode=DELETE", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    // Another process is inside a read transaction.
    reader
        .execute_batch("BEGIN; SELECT COUNT(*) FROM schema_migrations;")
        .unwrap();
    let opened = ContextDb::open(&path);
    assert!(
        opened.is_ok(),
        "context.db could not be opened while another process read it: {:?}",
        opened.err()
    );
    reader.execute_batch("COMMIT;").unwrap();
}

/// Control for the test above: once the file is in WAL mode the switch is a
/// no-op that takes no write lock, so the open succeeds while another
/// process holds the write lock. Passes with and without the WAL switch.
#[test]
fn control_a_wal_context_db_opens_while_another_process_holds_its_write_lock() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("context.db");
    drop(ContextDb::create_for_tests(&path).unwrap());
    let writer = Connection::open(&path).unwrap();
    let mode: String = writer
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    let opened = ContextDb::open(&path);
    assert!(opened.is_ok(), "{:?}", opened.err());
    writer.execute_batch("ROLLBACK;").unwrap();
}
