//! The source side of a move on a real module: `prepare`, `export`,
//! `release` and `abort`, with stand-ins for Entorhinal and Engram's
//! session door, over a `context.db` and a journal in a temporary folder.

use super::*;
use crate::agent_data::journal::{self as journal_file, MovingState};
use crate::agent_data::{snapshot, source, Journal, SESSION_MOVED, SESSION_MOVING};
use crate::client::{Child, ClientError, DoorRefusal, EntorhinalRefusal};
use crate::context_db::SCHEMA_VERSION;
use cortexkit_role_agent_data::errors::{ErrorBody, RefusalCode};
use cortexkit_role_agent_data::step::Step;
use cortexkit_role_compaction::{
    notice::Conditions,
    part::{Part, PartBody},
    read::{Cursor, Entry, Head, ReadPage, ReadRequest, Role},
    ride::RideCause,
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedView, AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
};
use cortexkit_role_llm_runner::{
    run::{RunResult, RunResultRequest},
    send::{SendReply, SendRequest},
};
use rusqlite::{params, Connection};
use serde_json::json;
use sha2::{Digest, Sha256};

const ENTORHINAL: &str = "reserved:entorhinal";
const CUT: &str = "0123456789abcdef0123456789abcdef";
const OTHER_CUT: &str = "fedcba9876543210fedcba9876543210";
const RUNNER: &str = "thalamus-harness";
const HARNESS: &str = "pi";
const PROJECT: &str = "git:proj";
const MIB: usize = 1024 * 1024;

/// Engram's session door as the source sees it: one append-only stream per
/// session, copied to the cloud as soon as it is written unless `lagging`.
#[derive(Default)]
struct Door {
    streams: HashMap<String, Vec<u8>>,
    /// How far each stream is in the cloud.
    cloud: HashMap<String, usize>,
    /// Each stream's trim floor.
    floors: HashMap<String, usize>,
    /// Admitted bytes stay behind in the cloud until a `session.cover`.
    lagging: bool,
    /// A `session.cover` uploads nothing.
    cover_stuck: bool,
    /// How many more `session.admit` calls succeed; `None` for all.
    admits_left: Option<usize>,
    /// Refusals for the next `session.admit` calls, in order, each with
    /// whether the page lands anyway.
    admit_refusals: Vec<(&'static str, bool)>,
    /// `offset_mismatch` leaves out `expectedOffset`.
    omit_expected: bool,
    /// The next `session.offsets` reports this durable end instead.
    stale_offsets: Option<usize>,
    /// The next `session.read` finds the floor raised to this first.
    raise_floor_on_read: Option<usize>,
    /// Every admitted page: session, offset, length.
    admitted: Vec<(String, u64, usize)>,
    /// Every read's start.
    reads: Vec<u64>,
    /// Every call: method and deadline.
    calls: Vec<(String, std::time::Duration)>,
}

impl Door {
    fn count(&self, method: &str) -> usize {
        self.calls
            .iter()
            .filter(|(called, _)| called == method)
            .count()
    }
}

/// The runner, Entorhinal and the door, as a move's source meets them.
#[derive(Default)]
struct Mover {
    /// Entorhinal's binding per ref, as `agent.session_for_ref` answers it.
    bindings: Mutex<HashMap<String, Value>>,
    door: Mutex<Door>,
    /// Run once, at the next door call.
    on_door: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl RunnerClient for Mover {
    async fn read(&self, _: &SessionRef, _: ReadRequest) -> Result<ReadPage, ClientError> {
        Ok(ReadPage::new(vec![], Head::new()))
    }
    async fn apply_view(
        &self,
        _: &SessionRef,
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::default())
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

    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, EntorhinalRefusal>> {
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["method"], "agent.session_for_ref");
        let reference = request["params"]["ref"].as_str().unwrap();
        let found = self.bindings.lock().unwrap().get(reference).cloned();
        Some(match found {
            Some(binding) => Ok(serde_json::to_vec(&json!({"result": binding})).unwrap()),
            None => Err(EntorhinalRefusal {
                code: "not_found".into(),
                message: "no agent session is registered under this reference".into(),
                detail: None,
            }),
        })
    }

    async fn door_call(
        &self,
        method: &str,
        params: Value,
        deadline: std::time::Duration,
    ) -> Result<Value, DoorRefusal> {
        let hook = self.on_door.lock().unwrap().take();
        if let Some(hook) = hook {
            hook();
        }
        let mut door = self.door.lock().unwrap();
        door.calls.push((method.to_owned(), deadline));
        let session = params["sessionRef"].as_str().unwrap().to_owned();
        let stream = door.streams.get(&session).cloned().unwrap_or_default();
        let floor = door.floors.get(&session).copied().unwrap_or(0);
        let cloud = door.cloud.get(&session).copied().unwrap_or(0);
        let refusal = |code: &str, detail: Option<Value>| DoorRefusal {
            code: code.into(),
            message: format!("the stand-in door refuses {code}"),
            detail,
        };
        match method {
            "session.offsets" => {
                let durable = door.stale_offsets.take().unwrap_or(stream.len());
                Ok(json!({"durableOffset": durable, "cloudOffset": cloud, "added": "ignored"}))
            }
            "session.cover" => {
                assert!(
                    cloud < stream.len(),
                    "session.cover called where an offset read was meant: the cloud has the whole stream"
                );
                let covered = if door.cover_stuck {
                    cloud
                } else {
                    stream.len()
                };
                door.cloud.insert(session, covered);
                Ok(json!({"durableOffset": stream.len(), "cloudOffset": covered}))
            }
            "session.admit" => {
                let from = params["fromOffset"].as_u64().unwrap();
                let bytes = crate::agent_data::door::unhex(params["bytes"].as_str().unwrap())
                    .expect("admitted bytes are hex");
                assert!(bytes.len() <= MIB, "a page carries at most 1 MiB");
                if door.admits_left == Some(0) {
                    return Err(refusal("lease_unavailable", None));
                }
                door.admits_left = door.admits_left.map(|left| left - 1);
                if from != stream.len() as u64 {
                    let detail =
                        (!door.omit_expected).then(|| json!({"expectedOffset": stream.len()}));
                    return Err(refusal("offset_mismatch", detail));
                }
                let refused =
                    (!door.admit_refusals.is_empty()).then(|| door.admit_refusals.remove(0));
                if refused.is_none_or(|(_, lands)| lands) {
                    door.admitted.push((session.clone(), from, bytes.len()));
                    let lagging = door.lagging;
                    let stream = door.streams.entry(session.clone()).or_default();
                    stream.extend(bytes);
                    let end = stream.len();
                    if !lagging {
                        door.cloud.insert(session.clone(), end);
                    }
                }
                if let Some((code, _)) = refused {
                    return Err(refusal(code, None));
                }
                let end = door.streams[&session].len();
                Ok(
                    json!({"durableOffset": end, "cloudOffset": door.cloud.get(&session).copied().unwrap_or(0)}),
                )
            }
            "session.digest" => {
                let end = params["end"].as_u64().unwrap() as usize;
                if end > stream.len() {
                    return Err(refusal(
                        "offset_out_of_range",
                        Some(json!({"streamEnd": stream.len()})),
                    ));
                }
                if end < floor {
                    return Err(refusal("below_floor", Some(json!({"floor": floor}))));
                }
                Ok(json!({
                    "end": end,
                    "digest": sha256(&stream[..end]),
                    "floor": floor,
                    "midstate": midstate_at(&stream[..floor]),
                }))
            }
            "session.read" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                let limit = params["limit"].as_u64().unwrap() as usize;
                assert!(limit <= MIB, "a read asks for at most 1 MiB");
                door.reads.push(from as u64);
                let floor = match door.raise_floor_on_read.take() {
                    Some(raised) => {
                        door.floors.insert(session.clone(), raised);
                        raised
                    }
                    None => floor,
                };
                if from < floor {
                    return Err(refusal("below_floor", Some(json!({"floor": floor}))));
                }
                if from > stream.len() {
                    return Err(refusal(
                        "offset_out_of_range",
                        Some(json!({"streamEnd": stream.len()})),
                    ));
                }
                let bytes = &stream[from..stream.len().min(from + limit)];
                Ok(json!({
                    "bytes": crate::agent_data::door::hex(bytes),
                    "fromOffset": from,
                    "endOffset": from + bytes.len(),
                    "streamEnd": stream.len(),
                }))
            }
            other => panic!("the source never calls {other}"),
        }
    }
}

/// SHA-256's running state after `bytes`, encoded as the door encodes it,
/// computed with the compression function alone.
fn midstate_at(bytes: &[u8]) -> Value {
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let full = bytes.len() - bytes.len() % 64;
    for block in bytes[..full].chunks(64) {
        sha2::compress256(
            &mut state,
            std::slice::from_ref(sha2::digest::generic_array::GenericArray::from_slice(block)),
        );
    }
    let chaining: Vec<u8> = state.iter().flat_map(|word| word.to_be_bytes()).collect();
    json!({
        "chaining": crate::agent_data::door::hex(&chaining),
        "tail": crate::agent_data::door::hex(&bytes[full..]),
    })
}

impl Router for Mover {
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

struct Fixture {
    module: Module<Mover>,
    db: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

fn key(session: &str) -> SessionRef {
    SessionRef::new(RUNNER, HARNESS, session)
}

fn route(session: &str) -> Route {
    Route {
        session: key(session),
        project: Some(crate::route::Project {
            id: PROJECT.into(),
            root: "/work/proj".into(),
        }),
        workdir: None,
        agent_id: None,
    }
}

fn conditions() -> Conditions {
    Conditions::new(
        ModelRef::new("test", "model"),
        100_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
    )
}

fn notice(ordinal: u64) -> NoticeRequest {
    let mid = format!("m{ordinal}");
    let entry = Entry::new(
        ordinal,
        &mid,
        Role::Assistant,
        ordinal,
        vec![Part::new("p", PartBody::Text { text: mid.clone() })],
    );
    let mut notice = NoticeRequest::new(ordinal, conditions()).with_newest(Cursor::new(
        ordinal,
        mid,
        entry.digest.clone(),
    ));
    notice.entries = vec![entry];
    notice
}

fn refs(names: &[&str]) -> Value {
    Value::Array(
        names
            .iter()
            .map(|name| json!({"ref_kind": "pi-session", "ref": name}))
            .collect(),
    )
}

fn cut_params(cut: &str, names: &[&str]) -> Value {
    json!({"refs": refs(names), "cutId": cut})
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("context.db");
        let context = crate::context_db::ContextDb::create_for_tests(&db).unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let journal = Arc::new(Journal::load(journal_file::path(&db)));
        let module = Module::with_journal(
            Mover::default(),
            Settings::default(),
            Some(context),
            Some(store),
            journal,
            true,
        );
        Self {
            module,
            db,
            _dir: dir,
        }
    }

    /// Entorhinal resolves the `pi-session` ref named like the session to
    /// it, under the runner that owns the kind.
    fn bind(&self, session: &str) {
        self.bind_as("pi-session", session, Some(RUNNER), session);
    }

    fn bind_as(&self, kind: &str, reference: &str, runner: Option<&str>, session: &str) {
        let mut binding = json!({
            "agent_id": "agent_0000000000000101",
            "ref_kind": kind,
            "ref": reference,
            "harness": HARNESS,
            "session_id": session,
            "project_root": null,
            "incarnation": "0123456789abcdef",
        });
        if let Some(runner) = runner {
            binding["runner"] = json!(runner);
        }
        self.module
            .inner
            .client
            .bindings
            .lock()
            .unwrap()
            .insert(reference.to_owned(), binding);
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }

    fn door(&self) -> std::sync::MutexGuard<'_, Door> {
        self.module.inner.client.door.lock().unwrap()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        let body = serde_json::to_vec(&json!({"method": method, "params": params})).unwrap();
        let reply = self.module.agent_data(ENTORHINAL, &body).await?;
        Ok(serde_json::from_slice(&reply).unwrap())
    }

    async fn prepare(&self, cut: &str, names: &[&str]) -> Result<Value, ErrorBody> {
        self.call("agent_data.prepare", cut_params(cut, names))
            .await
    }

    async fn export(&self, cut: &str, names: &[&str]) -> Result<Value, ErrorBody> {
        self.call("agent_data.export", cut_params(cut, names)).await
    }

    async fn release(&self, cut: &str, names: &[&str], holder: &str) -> Result<Value, ErrorBody> {
        self.call(
            "agent_data.release",
            json!({"refs": refs(names), "cutId": cut, "holder": holder}),
        )
        .await
    }

    async fn abort(&self, cut: &str, names: &[&str]) -> Result<Value, ErrorBody> {
        self.call("agent_data.abort", cut_params(cut, names)).await
    }

    async fn status(&self, cut: &str) -> Value {
        self.call("agent_data.status", cut_params(cut, &[]))
            .await
            .unwrap()["step"]
            .clone()
    }

    /// Set the session up and confirm the view its Setup offered, as the
    /// runner's next notice does, so nothing of it is busy.
    async fn settle(&self, session: &str) {
        let key = key(session);
        self.module
            .setup(
                route(session),
                SetupRequest::new(
                    "head",
                    ModelRef::new("test", "model"),
                    100_000,
                    1000,
                    ProviderRules::new(SignedParts::None, EditCost::Suffix),
                    vec![],
                    1,
                ),
            )
            .unwrap();
        self.module.idle(&key).await.unwrap();
        let offered = self
            .durable(session)
            .unconfirmed
            .last()
            .map(|pending| pending.view.clone());
        if let Some(offered) = offered {
            let mut confirm = notice(1);
            confirm.applied_view = Some(AppliedView::new(offered.version, offered.checksum));
            self.module.notice(&key, confirm).unwrap();
            self.module.idle(&key).await.unwrap();
        }
    }

    fn durable(&self, session: &str) -> crate::store::Durable {
        self.module
            .inner
            .store
            .as_ref()
            .unwrap()
            .load(&key(session))
            .expect("the session was saved")
    }

    /// Queue a notice on the session's worker as one acknowledged before a
    /// freeze would be: past admission, so the worker decides what to do.
    fn queue(&self, session: &str, ordinal: u64) {
        self.module
            .send(&key(session), Job::Notice(notice(ordinal)))
            .unwrap();
    }

    /// Each message's state in the app projection, read past the gate.
    async fn states(&self, session: &str, ids: &[&str]) -> Result<Vec<String>, String> {
        self.module
            .inner
            .app_read
            .read(
                "context.states",
                json!({"session": key(session), "message_ids": ids}),
            )
            .await
            .map(|reply| {
                reply["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|message| message["state"].as_str().unwrap().to_owned())
                    .collect()
            })
            .map_err(|refusal| refusal.code)
    }

    fn moving(&self, session: &str) -> Option<(String, MovingState)> {
        self.module
            .journal()
            .contents()
            .unwrap()
            .session(RUNNER, HARNESS, session)
            .and_then(|entry| entry.moving.clone())
            .map(|moving| (moving.cut, moving.state))
    }
}

/// A session's rows: two summaries, a session note, its project link, and
/// one committed publication with a waiting fact and a decided one.
fn seed(conn: &Connection, session: &str, content: &str) {
    for sequence in [1, 2] {
        conn.execute(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                title, content, p1, importance, created_at, harness)
             VALUES (?1, ?2, ?3, ?4, 'm-a', 'm-b', ?5, ?6, 'p1', 60, 100, ?7)",
            params![session, sequence, sequence * 10, sequence * 10 + 9, format!("summary {sequence}"), content, HARNESS],
        )
        .unwrap();
    }
    conn.execute_batch(&format!(
        "INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, harness)
            VALUES ('session', 'active', 'a note', '{session}', '{PROJECT}', 1, 1, '{HARNESS}');
         INSERT INTO session_projects(session_id, harness, project_path, updated_at)
            VALUES ('{session}', '{HARNESS}', '{PROJECT}', 1);"
    ))
    .unwrap();
    publication(conn, &format!("pub-{session}"), session);
    fact(conn, &format!("pub-{session}"), 0, "retryable", None);
    fact(conn, &format!("pub-{session}"), 1, "applied", None);
}

/// A committed publication of the session, its first turn published.
fn publication(conn: &Connection, id: &str, session: &str) {
    conn.execute(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications), 1)",
        params![id, PROJECT, session],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
            session_id, harness, carrier, state, request_json, started_at)
         VALUES (?1, ?2, ?3, 1, 'turn_one', ?4, ?5, 'ck-mc', 'published', '{}', 1)",
        params![
            json!([PROJECT, id, 1, "turn_one"]).to_string(),
            PROJECT,
            id,
            session,
            HARNESS
        ],
    )
    .unwrap();
}

fn fact(conn: &Connection, publication: &str, index: i64, state: &str, key: Option<&str>) {
    conn.execute(
        "INSERT INTO memory_pending_facts(project_path, publication_id, fact_index, category, content, state, reserved_stage_key)
         VALUES (?1, ?2, ?3, 'Decisions', ?4, ?5, ?6)",
        params![PROJECT, publication, index, format!("fact {publication} {index}"), state, key],
    )
    .unwrap();
}

/// Each fact of the publication: its index, state and reservation.
fn facts(conn: &Connection, publication: &str) -> Vec<(i64, String, Option<String>)> {
    conn.prepare(
        "SELECT fact_index, state, reserved_stage_key FROM memory_pending_facts
         WHERE publication_id = ?1 ORDER BY fact_index",
    )
    .unwrap()
    .query_map([publication], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn waiting(index: i64) -> (i64, String, Option<String>) {
    (index, "retryable".into(), None)
}

fn reserved(index: i64, cut: &str) -> (i64, String, Option<String>) {
    (index, "in_flight".into(), Some(format!("agent-data:{cut}")))
}

fn applied(index: i64) -> (i64, String, Option<String>) {
    (index, "applied".into(), None)
}

/// The facts a second turn of the project sends for `publication`: its own
/// `retryable` facts, then the backlog of every other committed
/// publication's `retryable` facts, in the second turn's own query.
fn second_turn(conn: &Connection, publication: &str) -> Vec<String> {
    let mut own: Vec<String> = conn
        .prepare(
            "SELECT f.content FROM memory_pending_facts f
             WHERE f.project_path = ?1 AND f.publication_id = ?2 AND f.state = 'retryable' ORDER BY f.id",
        )
        .unwrap()
        .query_map(params![PROJECT, publication], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let backlog: Vec<String> = conn
        .prepare(
            "SELECT f.content FROM memory_pending_facts f
             JOIN memory_publications p ON p.publication_id = f.publication_id
             WHERE f.project_path = ?1 AND f.publication_id != ?2 AND f.state = 'retryable'
               AND p.commit_order IS NOT NULL
             ORDER BY p.commit_order, f.id",
        )
        .unwrap()
        .query_map(params![PROJECT, publication], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    own.extend(backlog);
    own
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Capture every log line written on this thread from here on: a test's
/// runtime runs the module's workers on the test's own thread.
fn capture() -> (Arc<Mutex<Vec<u8>>>, tracing::subscriber::DefaultGuard) {
    #[derive(Clone)]
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
    let output = Arc::new(Mutex::new(Vec::new()));
    let writer = Captured(output.clone());
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    (output, tracing::subscriber::set_default(subscriber))
}

fn text(output: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8(output.lock().unwrap().clone()).unwrap()
}

/// `prepare` on a session with a worker: the worker is parked between two
/// jobs while the session is checked, frozen, reserved and read. The reply
/// names the session's door stream and the cut's end and digest, frozen.
/// The waiting fact is reserved under the cut, so a second turn of another
/// session of the project sends none of the moved session's facts and still
/// sends its own, and the snapshot reads the reserved fact as `retryable`.
#[tokio::test]
async fn prepare_freezes_the_session_reserves_its_waiting_facts_and_replies_frozen() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    seed(&conn, "s2", "content");
    f.bind("s1");
    f.settle("s1").await;
    let before = second_turn(&conn, "pub-s2");
    assert_eq!(before, ["fact pub-s2 0", "fact pub-s1 0"]);

    let reply = f.prepare(CUT, &["s1"]).await.unwrap();
    let file = source::snapshot_file(&f.db, CUT, &source::session_ref(&key("s1")));
    let bytes = std::fs::read(&file).unwrap();
    let item = &reply["items"][0];
    assert_eq!(item["ref_kind"], "pi-session");
    assert_eq!(item["ref"], "s1");
    assert_eq!(item["sessionRef"], source::session_ref(&key("s1")));
    assert_eq!(item["stream"], "reserved:magic-context");
    assert_eq!(item["endOffset"], bytes.len());
    // The session's stream on the door is empty, so the cut's digest is the
    // snapshot's own.
    assert_eq!(item["digest"], sha256(&bytes));
    assert_eq!(
        item["format"],
        format!("mc-agent-data-session/1+context.db/{SCHEMA_VERSION}")
    );
    assert_eq!(item["frozen"], true);
    assert_eq!(reply["external"], json!([]));

    assert_eq!(f.moving("s1"), Some((CUT.into(), MovingState::Frozen)));
    assert_eq!(f.status(CUT).await, "prepared");
    assert_eq!(facts(&conn, "pub-s1"), [reserved(0, CUT), applied(1)]);
    assert_eq!(facts(&conn, "pub-s2"), [waiting(0), applied(1)]);
    assert_eq!(second_turn(&conn, "pub-s2"), ["fact pub-s2 0"]);
    // The snapshot carries the reserved fact as waiting, as any encoding
    // of the session's rows now does.
    let now = snapshot::read(&mut f.conn(), &key("s1")).unwrap();
    assert_eq!(now.bytes, bytes);
    let decoded = snapshot::decode(&bytes).unwrap();
    let states: Vec<&Value> = decoded
        .rows
        .table("memory_pending_facts")
        .iter()
        .map(|row| &row["state"])
        .collect();
    assert_eq!(states, [&json!("retryable"), &json!("applied")]);

    // Every surface refuses the session, and its worker is free again.
    let refused = f.module.notice(&key("s1"), notice(2)).unwrap_err();
    assert!(matches!(refused, ModuleError::Gated(gated) if gated.code == SESSION_MOVING));
    f.module.idle(&key("s1")).await.unwrap();
    // A repeat replays the reply.
    assert_eq!(f.prepare(CUT, &["s1"]).await.unwrap(), reply);
}

/// `prepare` refuses `incompatible_version` (as `unavailable`, the code the
/// contract lets it use) when the live `context.db` is at another schema
/// version than this build reads, and leaves nothing frozen or reserved.
#[tokio::test]
async fn prepare_refuses_a_context_db_at_another_schema_version() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    conn.execute(
        "INSERT INTO schema_migrations(version, description, applied_at) VALUES (?1, 'newer', 1)",
        [SCHEMA_VERSION + 1],
    )
    .unwrap();
    let refused = f.prepare(CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert!(
        refused.message.contains("incompatible_version"),
        "{}",
        refused.message
    );
    assert_eq!(f.moving("s1"), None);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(f.status(CUT).await, "none");
    assert!(!source::cut_folder(&f.db, CUT).exists());
}

/// A ref is resolved only through Entorhinal's binding and its runner
/// module id. Refs `prepare` cannot cut are refused before anything is
/// frozen: one Entorhinal does not know, a binding without a runner, a
/// runner that does not own the kind, two refs naming one session's rows,
/// and a ref another cut holds.
#[tokio::test]
async fn prepare_refuses_refs_it_cannot_cut_before_freezing_anything() {
    let f = Fixture::new();
    let conn = f.conn();
    for session in ["s1", "s2"] {
        seed(&conn, session, "content");
        f.bind(session);
    }
    f.bind_as("pi-session", "no-runner", None, "s3");
    f.bind_as("pi-session", "wrong-runner", Some("broca"), "s3");
    // Broca's ref to the same rows as s1: context.db has no runner column.
    f.bind_as("broca-session", "b1", Some("broca"), "s1");

    for (names, why) in [
        (&["s1", "missing"][..], "unknown to Entorhinal"),
        (&["s1", "no-runner"], "a binding without a runner"),
        (
            &["s1", "wrong-runner"],
            "a runner that does not own the kind",
        ),
    ] {
        let refused = f.prepare(CUT, names).await.unwrap_err();
        assert_eq!(refused.code, RefusalCode::UnknownRef, "{why}");
        assert_eq!(
            refused.detail,
            Some(json!({"ref_kind": "pi-session", "ref": names[1]})),
            "{why}"
        );
    }
    let refused = f
        .call(
            "agent_data.prepare",
            json!({"cutId": CUT, "refs": [
                {"ref_kind": "pi-session", "ref": "s1"},
                {"ref_kind": "broca-session", "ref": "b1"},
            ]}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, RefusalCode::NotExportable);
    assert_eq!(f.moving("s1"), None);

    // s2 frozen by another cut: a cut naming it is refused invalid_state,
    // and s1, before it in the request, is not frozen either.
    f.prepare(OTHER_CUT, &["s2"]).await.unwrap();
    let refused = f.prepare(CUT, &["s1", "s2"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::InvalidState);
    assert_eq!(refused.detail, Some(json!({"step": "none"})));
    assert!(refused.message.contains(OTHER_CUT), "{}", refused.message);
    assert_eq!(f.moving("s1"), None);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(f.status(CUT).await, "none");
}

/// A fact of the session held by another session's second-turn send makes
/// `busy` and `prepare` answer `facts_in_flight`, and nothing is frozen or
/// reserved. That lasts until a later second turn's recovery gives the
/// stage up; then the same `prepare` succeeds.
#[tokio::test]
async fn a_fact_another_send_holds_refuses_prepare_until_recovery_gives_it_up() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    let stage = json!([PROJECT, "pub-s9", 1, "turn_two"]).to_string();
    fact(&conn, "pub-s1", 2, "in_flight", Some(&stage));

    for _ in 0..2 {
        let busy = f
            .call("agent_data.busy", json!({"refs": refs(&["s1"])}))
            .await
            .unwrap();
        assert_eq!(busy["refs"][0]["reason_code"], "facts_in_flight");
        let refused = f.prepare(CUT, &["s1"]).await.unwrap_err();
        assert_eq!(refused.code, RefusalCode::Busy);
        assert_eq!(
            refused.detail.as_ref().unwrap()["refs"][0]["reason_code"],
            "facts_in_flight"
        );
        assert_eq!(f.moving("s1"), None);
        assert_eq!(f.status(CUT).await, "none");
        assert_eq!(
            facts(&conn, "pub-s1")[..2],
            [waiting(0), applied(1)],
            "nothing reserved"
        );
    }

    // The second turn's recovery gives the stage up: its fact is retryable.
    conn.execute(
        "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL
         WHERE reserved_stage_key = ?1",
        [&stage],
    )
    .unwrap();
    f.prepare(CUT, &["s1"]).await.unwrap();
    assert_eq!(
        facts(&conn, "pub-s1"),
        [reserved(0, CUT), applied(1), reserved(2, CUT)]
    );
}

/// The reservation itself checks for a fact a send holds in the same write
/// transaction, so a send that took a fact after `busy` was checked still
/// refuses the reservation, and nothing is reserved.
#[test]
fn the_reservation_refuses_in_its_own_transaction_when_a_send_holds_a_fact() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("context.db");
    drop(crate::context_db::ContextDb::create_for_tests(&db).unwrap());
    let mut conn = Connection::open(&db).unwrap();
    seed(&conn, "s1", "content");
    let stage = json!([PROJECT, "pub-s9", 1, "turn_two"]).to_string();
    fact(&conn, "pub-s1", 2, "in_flight", Some(&stage));
    let held = source::reserve(&mut conn, &key("s1"), "agent-data:cut")
        .unwrap()
        .unwrap_err();
    assert_eq!(held.stage.as_deref(), Some(stage.as_str()));
    assert_eq!(facts(&conn, "pub-s1")[..2], [waiting(0), applied(1)]);
    conn.execute(
        "UPDATE memory_pending_facts SET state = 'applied', reserved_stage_key = NULL WHERE fact_index = 2",
        [],
    )
    .unwrap();
    assert_eq!(
        source::reserve(&mut conn, &key("s1"), "agent-data:cut").unwrap(),
        Ok(1)
    );
    // Repeating it reserves nothing more.
    assert_eq!(
        source::reserve(&mut conn, &key("s1"), "agent-data:cut").unwrap(),
        Ok(0)
    );
}

/// A `prepare` over two refs that is refused on the second leaves neither
/// frozen nor reserved: the first is unfrozen before the reply, and a
/// notice its worker held during the freeze runs.
#[tokio::test]
async fn a_prepare_refused_on_one_ref_leaves_neither_frozen_nor_reserved() {
    let (log, _guard) = capture();
    let f = Fixture::new();
    let conn = f.conn();
    for session in ["s1", "s2"] {
        seed(&conn, session, "content");
        f.bind(session);
    }
    let stage = json!([PROJECT, "pub-s9", 1, "turn_two"]).to_string();
    fact(&conn, "pub-s2", 2, "in_flight", Some(&stage));
    f.settle("s1").await;
    // While s1 is frozen, its worker is sent a notice, as one acknowledged
    // just before the freeze would be.
    let module = f.module.clone();
    *f.module.inner.client.on_door.lock().unwrap() = Some(Box::new(move || {
        module.send(&key("s1"), Job::Notice(notice(2))).unwrap();
    }));

    let refused = f.prepare(CUT, &["s1", "s2"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Busy);
    assert_eq!(
        refused.detail,
        Some(json!({"refs": [{
            "ref_kind": "pi-session",
            "ref": "s2",
            "reason_code": "facts_in_flight",
            "reason": format!("A second turn holds one of this session's facts (stage {stage})."),
        }]}))
    );
    assert_eq!(f.moving("s1"), None);
    assert_eq!(f.moving("s2"), None);
    assert_eq!(f.status(CUT).await, "none");
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    assert!(!source::cut_folder(&f.db, CUT).exists());
    f.module.idle(&key("s1")).await.unwrap();
    let logged = text(&log);
    assert!(
        logged.contains("thalamus-harness/pi/s1: holding its Setup and notices"),
        "{logged}"
    );
    assert!(
        logged.contains("thalamus-harness/pi/s1: running 1 jobs held during a move"),
        "{logged}"
    );
    assert_eq!(f.states("s1", &["m2"]).await, Ok(vec!["raw".into()]));
}

/// `export` admits the snapshot in pages of at most 1 MiB, resumes from
/// what the door already holds after a failure, and records the session's
/// baseline, its snapshot body's digest, only once all of it is admitted.
#[tokio::test]
async fn export_admits_the_snapshot_in_pages_and_resumes_from_what_the_door_holds() {
    let f = Fixture::new();
    let conn = f.conn();
    // Two summaries of 1.2 MiB each: a snapshot of three pages.
    seed(&conn, "s1", &"x".repeat(MIB + MIB / 5));
    f.bind("s1");
    let prepared = f.prepare(CUT, &["s1"]).await.unwrap();
    let session_ref = source::session_ref(&key("s1"));
    let bytes = std::fs::read(source::snapshot_file(&f.db, CUT, &session_ref)).unwrap();
    assert!(bytes.len() > 2 * MIB && bytes.len() < 3 * MIB);

    f.door().admits_left = Some(1);
    let refused = f.export(CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert!(
        refused.message.contains("lease_unavailable"),
        "{}",
        refused.message
    );
    assert_eq!(f.status(CUT).await, "prepared");
    let baseline = |f: &Fixture| {
        f.module
            .journal()
            .contents()
            .unwrap()
            .session(RUNNER, HARNESS, "s1")
            .and_then(|entry| entry.baseline.clone())
    };
    assert_eq!(baseline(&f), None);

    f.door().admits_left = None;
    let reply = f.export(CUT, &["s1"]).await.unwrap();
    assert_eq!(
        reply,
        json!({"items": [{"sessionRef": session_ref, "endOffset": bytes.len()}]})
    );
    assert_eq!(
        reply["items"][0]["endOffset"],
        prepared["items"][0]["endOffset"]
    );
    {
        let door = f.door();
        assert_eq!(
            door.admitted,
            [
                (session_ref.clone(), 0, MIB),
                (session_ref.clone(), MIB as u64, MIB),
                (session_ref.clone(), 2 * MIB as u64, bytes.len() - 2 * MIB),
            ]
        );
        assert_eq!(door.streams[&session_ref], bytes);
    }
    let header = snapshot::decode(&bytes).unwrap().header;
    assert_eq!(baseline(&f), Some(header.body_sha256));
    assert_eq!(f.status(CUT).await, "exported");
    // A repeat replays the reply and admits nothing again.
    assert_eq!(f.export(CUT, &["s1"]).await.unwrap(), reply);
    assert_eq!(f.door().admitted.len(), 3);
}

/// A later move of the same session appends its snapshot to the session's
/// stream on the door, and the cut's digest covers every byte up to it.
#[tokio::test]
async fn a_later_cut_of_a_session_builds_on_what_its_stream_already_holds() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.export(CUT, &["s1"]).await.unwrap();
    f.abort(CUT, &["s1"]).await.unwrap();
    let session_ref = source::session_ref(&key("s1"));
    let earlier = f.door().streams[&session_ref].clone();

    let reply = f.prepare(OTHER_CUT, &["s1"]).await.unwrap();
    let bytes = std::fs::read(source::snapshot_file(&f.db, OTHER_CUT, &session_ref)).unwrap();
    let mut stream = earlier.clone();
    stream.extend(&bytes);
    assert_eq!(reply["items"][0]["endOffset"], stream.len());
    assert_eq!(reply["items"][0]["digest"], sha256(&stream));
    f.export(OTHER_CUT, &["s1"]).await.unwrap();
    assert_eq!(f.door().streams[&session_ref], stream);
}

/// `release` turns the freeze into a tombstone naming the new holder: every
/// surface then refuses the session `session_moved`, the jobs its worker
/// held are discarded with a log line, and its worker, Setup and cached
/// project are gone. Its facts stay reserved, so neither a second turn here
/// nor a later `prepare` takes them; other sessions are served as before.
#[tokio::test]
async fn release_tombstones_the_session_and_keeps_its_facts_reserved() {
    let (log, _guard) = capture();
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    seed(&conn, "s2", "content");
    f.bind("s1");
    f.settle("s1").await;
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.export(CUT, &["s1"]).await.unwrap();
    f.queue("s1", 2);
    f.module.idle(&key("s1")).await.unwrap();
    assert!(f
        .module
        .inner
        .workers
        .lock()
        .unwrap()
        .contains_key(&key("s1")));

    let reply = f.release(CUT, &["s1"], "mac-b").await.unwrap();
    assert_eq!(reply, json!({"enforced": true}));
    assert_eq!(f.status(CUT).await, "released");
    // The worker discards what it held once it gets to its last job.
    let discarded = format!(
        "session thalamus-harness/pi/s1 was released to another machine by agent-data cut {CUT}; discarding the 1 Setup, notice and summary jobs held during the move"
    );
    for _ in 0..100 {
        if text(&log).contains(&discarded) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let logged = text(&log);
    assert!(logged.contains(&discarded), "{logged}");
    assert!(!f
        .module
        .inner
        .workers
        .lock()
        .unwrap()
        .contains_key(&key("s1")));
    assert!(!f.module.inner.set_up.lock().unwrap().contains(&key("s1")));
    assert!(!f
        .module
        .inner
        .session_projects
        .lock()
        .unwrap()
        .contains_key(&key("s1")));
    assert!(!source::cut_folder(&f.db, CUT).exists());

    // The facts stay reserved, and a second turn of another session sends
    // only its own.
    assert_eq!(facts(&conn, "pub-s1"), [reserved(0, CUT), applied(1)]);
    assert_eq!(second_turn(&conn, "pub-s2"), ["fact pub-s2 0"]);
    // What the door holds is the body encoded from the rows now, the
    // reserved fact read as waiting.
    let session_ref = source::session_ref(&key("s1"));
    assert_eq!(
        f.door().streams[&session_ref],
        snapshot::read(&mut f.conn(), &key("s1")).unwrap().bytes
    );

    let moved = |result: Result<(), ModuleError>| match result {
        Err(ModuleError::Gated(gated)) => {
            assert_eq!(gated.code, SESSION_MOVED);
            assert_eq!(gated.detail, Some(json!({"holder": "mac-b"})));
        }
        other => panic!("expected session_moved, got {other:?}"),
    };
    moved(
        f.module
            .setup(
                route("s1"),
                SetupRequest::new(
                    "head",
                    ModelRef::new("test", "model"),
                    100_000,
                    1000,
                    ProviderRules::new(SignedParts::None, EditCost::Suffix),
                    vec![],
                    1,
                ),
            )
            .map(drop),
    );
    moved(f.module.notice(&key("s1"), notice(3)).map(drop));
    moved(
        f.module
            .ride(
                &key("s1"),
                RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions()),
            )
            .await
            .map(drop),
    );
    moved(
        f.module
            .tool(&route("s1"), "ctx_note", json!({}))
            .await
            .map(drop),
    );
    let refused = f
        .module
        .app_request(
            "session_data.read",
            json!({"session": key("s1"), "section": "meta"}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, SESSION_MOVED);

    // A new cut cannot take the session back out, and the released cut
    // cannot be aborted.
    let refused = f.prepare(OTHER_CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::UnknownRef);
    assert!(
        refused.message.contains("session_moved"),
        "{}",
        refused.message
    );
    assert!(refused.message.contains("mac-b"), "{}", refused.message);
    assert_eq!(f.status(OTHER_CUT).await, "none");
    let refused = f.abort(CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::InvalidState);
    assert_eq!(refused.detail, Some(json!({"step": "released"})));
    assert_eq!(facts(&conn, "pub-s1"), [reserved(0, CUT), applied(1)]);

    // Another session is served as before.
    f.settle("s2").await;
    f.bind("s2");
    f.prepare(OTHER_CUT, &["s2"]).await.unwrap();
}

/// `abort` before `release` lets the reservation go, then unfreezes the
/// session, deletes its snapshot and runs the jobs its worker held, in
/// order. The session carries on with the view and the saved state it had
/// before the move.
#[tokio::test]
async fn abort_before_release_lets_the_session_carry_on_as_before() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    f.settle("s1").await;
    let before = f.durable("s1");

    f.prepare(CUT, &["s1"]).await.unwrap();
    f.export(CUT, &["s1"]).await.unwrap();
    assert_eq!(f.abort(CUT, &["s1"]).await.unwrap(), json!({}));
    f.module.idle(&key("s1")).await.unwrap();
    assert_eq!(f.status(CUT).await, "aborted");
    assert_eq!(f.moving("s1"), None);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    assert!(!source::cut_folder(&f.db, CUT).exists());
    assert_eq!(f.durable("s1"), before);
    // A repeat replays its reply.
    assert_eq!(f.abort(CUT, &["s1"]).await.unwrap(), json!({}));

    // Notices held during a second move run in order once it is aborted.
    f.prepare(OTHER_CUT, &["s1"]).await.unwrap();
    f.queue("s1", 2);
    f.queue("s1", 3);
    f.module.idle(&key("s1")).await.unwrap();
    assert_eq!(f.durable("s1"), before, "held, not run");
    f.abort(OTHER_CUT, &["s1"]).await.unwrap();
    f.module.idle(&key("s1")).await.unwrap();
    assert_eq!(
        f.states("s1", &["m2", "m3"]).await,
        Ok(vec!["raw".into(), "raw".into()])
    );
    // And the session serves its next turn.
    assert_eq!(
        f.module.notice(&key("s1"), notice(4)),
        Ok(NoticeAnswer::Received)
    );
    assert!(f
        .module
        .ride(
            &key("s1"),
            RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions())
        )
        .await
        .is_ok());
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
}

/// `abort` lets the cut's reservation go before the journal write that
/// records the cut aborted. When that write fails, the facts are already
/// waiting again and the cut is not recorded aborted, so no fact is ever
/// reserved under a cut the journal says was aborted; the session stays
/// frozen until the abort is sent again.
#[tokio::test]
async fn abort_lets_the_reservation_go_before_the_journal_records_the_cut_aborted() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    f.prepare(CUT, &["s1"]).await.unwrap();
    assert_eq!(facts(&conn, "pub-s1"), [reserved(0, CUT), applied(1)]);

    // A folder where the journal file was: no journal write can land.
    let journal = journal_file::path(&f.db);
    std::fs::remove_file(&journal).unwrap();
    std::fs::create_dir_all(journal.join("blocked")).unwrap();
    let refused = f.abort(CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(f.status(CUT).await, "prepared");
    assert_eq!(f.moving("s1"), Some((CUT.into(), MovingState::Frozen)));

    std::fs::remove_dir_all(&journal).unwrap();
    assert_eq!(f.abort(CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(f.status(CUT).await, "aborted");
    assert_eq!(f.moving("s1"), None);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);
    let on_disk: journal_file::Contents =
        serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    assert_eq!(on_disk.cuts[CUT].step, Step::Aborted);
}

/// A crash can stop `prepare` after the freeze and before its reply. The
/// session then stays frozen, and a repeat of the same `prepare` runs again
/// over that state. When the crash came before the reservation and another
/// session's send took a fact meanwhile, the repeat refuses
/// `facts_in_flight` and unfreezes the session; when it came after, the
/// repeat finds the facts already reserved and replies.
#[tokio::test]
async fn a_prepare_cut_short_by_a_crash_is_finished_or_undone_by_its_repeat() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    let freeze = || {
        f.module
            .journal()
            .change(|contents| {
                contents.session_mut(RUNNER, HARNESS, "s1").moving = Some(journal_file::Moving {
                    cut: CUT.into(),
                    state: MovingState::Frozen,
                });
            })
            .unwrap()
    };
    // Frozen, then a send of another session took the waiting fact.
    freeze();
    let stage = json!([PROJECT, "pub-s9", 1, "turn_two"]).to_string();
    conn.execute(
        "UPDATE memory_pending_facts SET state = 'in_flight', reserved_stage_key = ?1 WHERE fact_index = 0",
        [&stage],
    )
    .unwrap();
    let refused = f.prepare(CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Busy);
    assert_eq!(f.moving("s1"), None);
    assert_eq!(f.status(CUT).await, "none");

    // The send gave the fact up. Frozen and reserved, then the crash.
    conn.execute(
        "UPDATE memory_pending_facts SET state = 'retryable', reserved_stage_key = NULL WHERE fact_index = 0",
        [],
    )
    .unwrap();
    freeze();
    source::reserve(&mut f.conn(), &key("s1"), &format!("agent-data:{CUT}"))
        .unwrap()
        .unwrap();
    let reply = f.prepare(CUT, &["s1"]).await.unwrap();
    assert_eq!(reply["items"][0]["frozen"], true);
    assert_eq!(f.moving("s1"), Some((CUT.into(), MovingState::Frozen)));
    assert_eq!(facts(&conn, "pub-s1"), [reserved(0, CUT), applied(1)]);
}

/// `export` reads where the stream ends with `session.offsets`, never with
/// `session.cover`. When an admission is refused `offset_mismatch`, it goes
/// on from the `expectedOffset` the refusal names, and reads the offsets
/// again only when the refusal names none.
#[tokio::test]
async fn export_goes_on_from_the_offset_a_mismatch_names() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", &"x".repeat(MIB + MIB / 5));
    seed(&conn, "s2", "content");
    f.bind("s1");
    f.bind("s2");
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.prepare(OTHER_CUT, &["s2"]).await.unwrap();
    let (s1, s2) = (
        source::session_ref(&key("s1")),
        source::session_ref(&key("s2")),
    );
    let snapshot1 = std::fs::read(source::snapshot_file(&f.db, CUT, &s1)).unwrap();
    let snapshot2 = std::fs::read(source::snapshot_file(&f.db, OTHER_CUT, &s2)).unwrap();

    // The first page landed once already, and the door's offsets are read
    // before that is visible: the admission from byte 0 is refused, and the
    // export goes on from the offset the refusal names.
    {
        let mut door = f.door();
        door.streams.insert(s1.clone(), snapshot1[..MIB].to_vec());
        door.cloud.insert(s1.clone(), MIB);
        door.stale_offsets = Some(0);
    }
    f.export(CUT, &["s1"]).await.unwrap();
    {
        let door = f.door();
        assert_eq!(door.streams[&s1], snapshot1);
        assert_eq!(
            door.admitted,
            [
                (s1.clone(), MIB as u64, MIB),
                (s1.clone(), 2 * MIB as u64, snapshot1.len() - 2 * MIB),
            ]
        );
        assert_eq!(
            door.count("session.offsets"),
            3,
            "prepare's two, export's one"
        );
        assert_eq!(door.count("session.cover"), 0);
    }

    // A refusal naming no offset: the export reads the offsets again.
    {
        let mut door = f.door();
        door.streams.insert(s2.clone(), snapshot2.clone());
        door.cloud.insert(s2.clone(), snapshot2.len());
        door.stale_offsets = Some(0);
        door.omit_expected = true;
    }
    let before = f.door().count("session.offsets");
    f.export(OTHER_CUT, &["s2"]).await.unwrap();
    let door = f.door();
    assert_eq!(door.streams[&s2], snapshot2);
    assert_eq!(door.count("session.offsets") - before, 2);
    assert_eq!(door.count("session.cover"), 0);
}

/// When the cloud lacks part of what earlier moves admitted, `prepare`
/// asks the door to upload it once with `session.cover`, under its own
/// ten-minute deadline, and checks again; every other door call keeps 30
/// seconds. A cover that leaves the cloud behind refuses `unavailable` and
/// leaves nothing frozen.
#[tokio::test]
async fn prepare_waits_once_for_the_cloud_when_it_is_behind() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    f.door().lagging = true;
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.export(CUT, &["s1"]).await.unwrap();
    f.abort(CUT, &["s1"]).await.unwrap();
    let session_ref = source::session_ref(&key("s1"));
    assert_eq!(f.door().cloud.get(&session_ref).copied().unwrap_or(0), 0);
    assert_eq!(f.door().count("session.cover"), 0);

    f.door().cover_stuck = true;
    let refused = f.prepare(OTHER_CUT, &["s1"]).await.unwrap_err();
    assert_eq!(refused.code, RefusalCode::Unavailable);
    assert_eq!(f.door().count("session.cover"), 1);
    assert_eq!(f.moving("s1"), None);
    assert_eq!(facts(&conn, "pub-s1"), [waiting(0), applied(1)]);

    f.door().cover_stuck = false;
    f.prepare(OTHER_CUT, &["s1"]).await.unwrap();
    let door = f.door();
    assert_eq!(door.count("session.cover"), 2);
    for (method, deadline) in &door.calls {
        let expected = if method == "session.cover" {
            std::time::Duration::from_secs(600)
        } else {
            std::time::Duration::from_secs(30)
        };
        assert_eq!(*deadline, expected, "{method}");
    }
}

/// The cut's digest resumes SHA-256 from the running state the door keeps
/// at the stream's trim floor and reads only the bytes from the floor on.
/// When a trim raises the floor during the read, it starts again from the
/// new floor. The digest still covers every byte of the stream.
#[tokio::test]
async fn the_cuts_digest_resumes_from_the_streams_floor() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", &"content ".repeat(40));
    f.bind("s1");
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.export(CUT, &["s1"]).await.unwrap();
    f.abort(CUT, &["s1"]).await.unwrap();
    let session_ref = source::session_ref(&key("s1"));
    let earlier = f.door().streams[&session_ref].clone();
    assert!(earlier.len() > 200);
    {
        let mut door = f.door();
        door.floors.insert(session_ref.clone(), 70);
        door.raise_floor_on_read = Some(130);
    }
    let reply = f.prepare(OTHER_CUT, &["s1"]).await.unwrap();
    let snapshot = std::fs::read(source::snapshot_file(&f.db, OTHER_CUT, &session_ref)).unwrap();
    let mut stream = earlier.clone();
    stream.extend(&snapshot);
    assert_eq!(reply["items"][0]["digest"], sha256(&stream));
    assert_eq!(reply["items"][0]["endOffset"], stream.len());
    let door = f.door();
    assert_eq!(door.reads, [70, 130], "nothing below the floor is read");
    assert_eq!(door.count("session.digest"), 2);
}

/// A door refusal on `session.admit` is answered by the table in `door.rs`:
/// a refusal Engram's contract says to retry, or one it does not list, is
/// `unavailable`; a container this machine no longer writes is
/// `unknown_ref`; another cut's pending handoff is `invalid_state` at the
/// cut's step, and a permanent fault is `participant_failed` with a
/// diagnostic reason. An answer too large for the frame whose page landed
/// is no refusal: the export goes on.
#[tokio::test]
async fn a_refused_admission_is_answered_by_the_doors_table() {
    let f = Fixture::new();
    let conn = f.conn();
    seed(&conn, "s1", "content");
    f.bind("s1");
    f.prepare(CUT, &["s1"]).await.unwrap();
    for (code, expected) in [
        ("lease_acquiring", RefusalCode::Unavailable),
        ("a_code_engram_added_later", RefusalCode::Unavailable),
        ("container_handed_off", RefusalCode::UnknownRef),
        ("lease_held_elsewhere", RefusalCode::UnknownRef),
        ("cut_pending_handoff", RefusalCode::InvalidState),
        ("caller_forbidden", RefusalCode::ParticipantFailed),
        ("response_too_large", RefusalCode::ParticipantFailed),
    ] {
        f.door().admit_refusals = vec![(code, false)];
        let refused = f.export(CUT, &["s1"]).await.unwrap_err();
        assert_eq!(refused.code, expected, "{code}");
        assert!(
            refused.message.contains(code),
            "{code}: {}",
            refused.message
        );
        match expected {
            RefusalCode::UnknownRef => assert_eq!(
                refused.detail,
                Some(json!({"ref_kind": "pi-session", "ref": "s1"})),
                "{code}"
            ),
            RefusalCode::InvalidState => {
                assert_eq!(refused.detail, Some(json!({"step": "prepared"})), "{code}")
            }
            RefusalCode::ParticipantFailed => assert_eq!(
                refused.participant_failed_detail().unwrap().unwrap().reason,
                Some(format!("session_door:{code} at prepared")),
                "{code}"
            ),
            _ => assert_eq!(refused.detail, None, "{code}"),
        }
        if code == "caller_forbidden" {
            assert!(
                refused
                    .message
                    .contains("The order of the cut's ops is not the cause"),
                "{}",
                refused.message
            );
        }
        assert_eq!(f.status(CUT).await, "prepared", "{code}");
        assert!(f.door().admitted.is_empty(), "{code}");
    }
    // The page landed though its answer was too large: the export reads
    // the offsets and goes on.
    f.door().admit_refusals = vec![("response_too_large", true)];
    f.export(CUT, &["s1"]).await.unwrap();
    assert_eq!(f.status(CUT).await, "exported");
}

impl Fixture {
    /// The same machine after a crash: the module and everything it kept in
    /// memory are gone, jobs its workers held included, and a new module
    /// starts over the same stores and journal, as `main.rs` starts one.
    fn restart(self) -> Self {
        let Self { module, db, _dir } = self;
        drop(module);
        let journal = Arc::new(Journal::load(journal_file::path(&db)));
        source::sweep(&db, &journal);
        let module = Module::with_journal(
            Mover::default(),
            Settings::default(),
            Some(crate::context_db::ContextDb::open(&db).unwrap()),
            Some(Store::open(&_dir.path().join("mode3.db")).unwrap()),
            journal,
            true,
        );
        Self { module, db, _dir }
    }
}

/// A notice the frozen worker held is lost with a crash, as any queued job
/// is. After the restart the session stays refused until the move is
/// aborted. The runner's next notice is then answered `setup_required`,
/// since this process never saw the session's Setup, and the Setup that
/// follows serves a turn.
#[tokio::test]
async fn a_notice_held_when_the_process_crashes_is_asked_for_a_setup_after_the_abort() {
    let f = Fixture::new();
    seed(&f.conn(), "s1", "content");
    f.bind("s1");
    f.settle("s1").await;
    let before = f.durable("s1");
    f.prepare(CUT, &["s1"]).await.unwrap();
    f.queue("s1", 2);
    f.module.idle(&key("s1")).await.unwrap();
    assert_eq!(f.durable("s1"), before, "held, not run");

    let f = f.restart();
    let refused = |result: Result<NoticeAnswer, ModuleError>| match result {
        Err(ModuleError::Gated(gated)) => gated.code,
        other => panic!("{other:?}"),
    };
    assert_eq!(
        refused(f.module.notice(&key("s1"), notice(3))),
        SESSION_MOVING
    );
    assert!(matches!(
        f.module.setup(route("s1"), SetupRequest::new(
            "head",
            ModelRef::new("test", "model"),
            100_000,
            1000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            vec![],
            1,
        )),
        Err(ModuleError::Gated(gated)) if gated.code == SESSION_MOVING
    ));
    assert_eq!(f.moving("s1"), Some((CUT.into(), MovingState::Frozen)));
    assert_eq!(facts(&f.conn(), "pub-s1"), [reserved(0, CUT), applied(1)]);

    assert_eq!(f.abort(CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(facts(&f.conn(), "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(
        f.module.notice(&key("s1"), notice(3)),
        Ok(NoticeAnswer::SetupRequired)
    );
    f.settle("s1").await;
    assert_eq!(
        f.module.notice(&key("s1"), notice(4)),
        Ok(NoticeAnswer::Received)
    );
    assert!(f
        .module
        .ride(
            &key("s1"),
            RideRequest::new(vec![RideCause::OverLimit], 1_000, conditions())
        )
        .await
        .is_ok());
    f.module.idle(&key("s1")).await.unwrap();
}
