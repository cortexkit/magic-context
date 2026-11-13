//! The receiver side of a move on real modules: `diverged`, `import`,
//! `activate` and the receiver's `abort`. Two modules, each with its own
//! `context.db`, `mode3.db` and journal in a temporary folder, stand for
//! two machines. They share stand-ins for Entorhinal and Engram's session
//! door, so a session prepared and exported on one is read and installed
//! on the other.

use super::*;
use crate::agent_data::journal::{self as journal_file, MovingState};
use crate::agent_data::{receiver, snapshot, source, Journal, SESSION_MOVED, SESSION_MOVING};
use crate::client::{Child, ClientError, DoorRefusal, EntorhinalRefusal};
use cortexkit_role_agent_data::errors::ErrorBody;
use cortexkit_role_compaction::{
    read::{Head, ReadPage, ReadRequest},
    rules::{EditCost, ProviderRules, SignedParts},
    setup::ModelRef,
    view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest},
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
const BACK: &str = "fedcba9876543210fedcba9876543210";
const THIRD: &str = "00112233445566778899aabbccddeeff";
const RUNNER: &str = "thalamus-harness";
const HARNESS: &str = "pi";
const PROJECT: &str = "git:proj";
const OTHER_PROJECT: &str = "git:other";

#[path = "receiver_samples_tests.rs"]
mod samples;

/// Engram's session door, shared by both machines: one append-only stream
/// per session, and the cuts Entorhinal sealed, each with its end and
/// digest per session.
#[derive(Default)]
struct Door {
    streams: HashMap<String, Vec<u8>>,
    sealed: HashMap<(String, String), (usize, String)>,
}

#[derive(Default)]
struct Shared {
    /// Entorhinal's binding per ref.
    bindings: Mutex<HashMap<String, Value>>,
    door: Mutex<Door>,
}

/// One machine's runner, Entorhinal and door, as a move meets them.
struct Mover(Arc<Shared>);

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
        let reference = request["params"]["ref"].as_str().unwrap();
        let found = self.0.bindings.lock().unwrap().get(reference).cloned();
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
        _deadline: std::time::Duration,
    ) -> Result<Value, DoorRefusal> {
        let mut door = self.0.door.lock().unwrap();
        let session = params["sessionRef"].as_str().unwrap().to_owned();
        let stream = door.streams.get(&session).cloned().unwrap_or_default();
        let refusal = |code: &str| DoorRefusal {
            code: code.into(),
            message: format!("the stand-in door refuses {code}"),
            detail: None,
        };
        match method {
            "session.offsets" => {
                Ok(json!({"durableOffset": stream.len(), "cloudOffset": stream.len()}))
            }
            "session.admit" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                if from != stream.len() {
                    return Err(DoorRefusal {
                        detail: Some(json!({"expectedOffset": stream.len()})),
                        ..refusal("offset_mismatch")
                    });
                }
                let bytes = door::unhex(params["bytes"].as_str().unwrap()).unwrap();
                let stream = door.streams.entry(session).or_default();
                stream.extend(bytes);
                Ok(json!({"durableOffset": stream.len(), "cloudOffset": stream.len()}))
            }
            "session.digest" => {
                let end = params["end"].as_u64().unwrap() as usize;
                Ok(json!({
                    "end": end,
                    "digest": sha256(&stream[..end]),
                    "floor": 0,
                    "midstate": initial_midstate(),
                }))
            }
            "session.read" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                let limit = params["limit"].as_u64().unwrap() as usize;
                let Some(cut) = params.get("cutId").and_then(Value::as_str) else {
                    let bytes = &stream[from..stream.len().min(from + limit)];
                    return Ok(json!({
                        "bytes": door::hex(bytes),
                        "fromOffset": from,
                        "endOffset": from + bytes.len(),
                        "streamEnd": stream.len(),
                    }));
                };
                let Some((end, digest)) = door.sealed.get(&(cut.to_owned(), session)).cloned()
                else {
                    return Err(refusal("not_found"));
                };
                let bytes = &stream[from..end.min(from + limit)];
                Ok(json!({
                    "bytes": door::hex(bytes),
                    "fromOffset": from,
                    "endOffset": from + bytes.len(),
                    "streamEnd": end,
                    "digest": digest,
                    "floor": 0,
                    "midstate": initial_midstate(),
                }))
            }
            other => panic!("a move never calls {other} here"),
        }
    }
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

/// SHA-256's running state before any byte, as the door encodes it.
fn initial_midstate() -> Value {
    let chaining: Vec<u8> = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ]
    .iter()
    .flat_map(|word| word.to_be_bytes())
    .collect();
    json!({"chaining": door::hex(&chaining), "tail": ""})
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

use crate::agent_data::door;

/// One machine: a module over its own stores in a temporary folder.
struct Machine {
    module: Module<Mover>,
    shared: Arc<Shared>,
    db: std::path::PathBuf,
    dir: tempfile::TempDir,
}

fn key(session: &str) -> SessionRef {
    SessionRef::new(RUNNER, HARNESS, session)
}

fn refs(names: &[&str]) -> Value {
    Value::Array(
        names
            .iter()
            .map(|name| json!({"ref_kind": "pi-session", "ref": name}))
            .collect(),
    )
}

impl Machine {
    fn new(shared: &Arc<Shared>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("context.db");
        let context = ContextDb::create_for_tests(&db).unwrap();
        let module = Self::module(shared, &dir, &db, context);
        Self {
            module,
            shared: Arc::clone(shared),
            db,
            dir,
        }
    }

    fn module(
        shared: &Arc<Shared>,
        dir: &tempfile::TempDir,
        db: &std::path::Path,
        context: ContextDb,
    ) -> Module<Mover> {
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let journal = Arc::new(Journal::load(journal_file::path(db)));
        Module::with_journal(
            Mover(Arc::clone(shared)),
            Settings::default(),
            Some(context),
            Some(store),
            journal,
            true,
        )
    }

    /// The same machine after a restart: a new module over the same stores
    /// and journal, which finishes any install the journal records started.
    async fn restart(self) -> Self {
        let Self {
            module,
            shared,
            db,
            dir,
        } = self;
        drop(module);
        let context = ContextDb::open(&db).unwrap();
        let module = Self::module(&shared, &dir, &db, context);
        module.inner.agent_data.recover(&module).await;
        Self {
            module,
            shared,
            db,
            dir,
        }
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        let body = serde_json::to_vec(&json!({"method": method, "params": params})).unwrap();
        let reply = self.module.agent_data(ENTORHINAL, &body).await?;
        Ok(serde_json::from_slice(&reply).unwrap())
    }

    async fn op(&self, op: &str, cut: &str, names: &[&str]) -> Result<Value, ErrorBody> {
        self.call(
            &format!("agent_data.{op}"),
            json!({"refs": refs(names), "cutId": cut}),
        )
        .await
    }

    async fn status(&self, cut: &str) -> Value {
        self.op("status", cut, &[]).await.unwrap()["step"].clone()
    }

    /// `diverged`'s state for each ref.
    async fn diverged(&self, cut: &str, names: &[&str]) -> Result<Vec<String>, ErrorBody> {
        Ok(self.op("diverged", cut, names).await?["refs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["state"].as_str().unwrap().to_owned())
            .collect())
    }

    /// Prepare and export the sessions, sealing the cut as Entorhinal does
    /// from `prepare`'s items, and return `prepare`'s reply.
    async fn send_out(&self, cut: &str, names: &[&str]) -> Value {
        let prepared = self.op("prepare", cut, names).await.unwrap();
        for item in prepared["items"].as_array().unwrap() {
            self.shared.door.lock().unwrap().sealed.insert(
                (
                    cut.to_owned(),
                    item["sessionRef"].as_str().unwrap().to_owned(),
                ),
                (
                    item["endOffset"].as_u64().unwrap() as usize,
                    item["digest"].as_str().unwrap().to_owned(),
                ),
            );
        }
        self.op("export", cut, names).await.unwrap();
        prepared
    }

    async fn release(&self, cut: &str, names: &[&str], holder: &str) {
        self.call(
            "agent_data.release",
            json!({"refs": refs(names), "cutId": cut, "holder": holder}),
        )
        .await
        .unwrap();
    }

    fn moving(&self, session: &str) -> Option<(String, MovingState)> {
        self.entry(session)
            .and_then(|entry| entry.moving)
            .map(|moving| (moving.cut, moving.state))
    }

    fn entry(&self, session: &str) -> Option<journal_file::SessionEntry> {
        self.module
            .journal()
            .contents()
            .unwrap()
            .session(RUNNER, HARNESS, session)
            .cloned()
    }

    /// The session's rows as a snapshot body encodes them.
    fn fingerprint(&self, session: &str) -> snapshot::Fingerprint {
        snapshot::fingerprint(&self.conn(), HARNESS, session).unwrap()
    }

    fn gate(&self, session: &str) -> Result<(), &'static str> {
        self.module
            .journal()
            .gate()
            .check(&key(session))
            .map_err(|gated| gated.code)
    }

    async fn context_memories(&self, session: &str) -> Result<Vec<String>, String> {
        let body = serde_json::to_vec(&json!({
            "method": "context.memories",
            "params": {
                "session": {"harness": HARNESS, "session": session},
                "purpose": "bias",
                "budget_tokens": 4000,
            },
        }))
        .unwrap();
        self.module
            .context_read()
            .read(&body)
            .await
            .map(|reply| {
                reply["memories"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|memory| memory["text"].as_str().unwrap().to_owned())
                    .collect()
            })
            .map_err(|refusal| refusal.code)
    }

    fn setup(&self, session: &str) -> Result<(), ModuleError> {
        self.module
            .setup(
                Route {
                    session: key(session),
                    project: Some(crate::route::Project {
                        id: PROJECT.into(),
                        root: "/work/proj".into(),
                    }),
                    workdir: None,
                    agent_id: None,
                },
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
            .map(|_| ())
    }
}

/// Two machines and the bindings Entorhinal resolves on both: each
/// `pi-session` ref named like its session, under the runner that owns the
/// kind.
fn machines(sessions: &[&str]) -> (Machine, Machine) {
    let shared = Arc::new(Shared::default());
    for session in sessions {
        shared.bindings.lock().unwrap().insert(
            (*session).to_owned(),
            json!({
                "agent_id": "agent_0000000000000101",
                "ref_kind": "pi-session",
                "ref": session,
                "harness": HARNESS,
                "session_id": session,
                "project_root": null,
                "incarnation": "0123456789abcdef",
                "runner": RUNNER,
            }),
        );
    }
    (Machine::new(&shared), Machine::new(&shared))
}

/// A session's rows: two summaries, a session note, its project link, and
/// one committed publication with a waiting fact and an applied one.
fn seed(conn: &Connection, session: &str, project: &str) {
    for sequence in [1, 2] {
        conn.execute(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                title, content, p1, importance, created_at, harness)
             VALUES (?1, ?2, ?3, ?4, 'm-a', 'm-b', ?5, 'content', 'p1', 60, 100, ?6)",
            params![session, sequence, sequence * 10, sequence * 10 + 9, format!("summary {sequence}"), HARNESS],
        )
        .unwrap();
    }
    conn.execute_batch(&format!(
        "INSERT INTO notes(type, status, content, session_id, project_path, created_at, updated_at, harness)
            VALUES ('session', 'active', 'a note', '{session}', '{project}', 1, 1, '{HARNESS}');
         INSERT INTO session_projects(session_id, harness, project_path, updated_at)
            VALUES ('{session}', '{HARNESS}', '{project}', 1);"
    ))
    .unwrap();
    publication(conn, &format!("pub-{session}"), session, project);
    fact(conn, &format!("pub-{session}"), 0, "retryable", None);
    fact(conn, &format!("pub-{session}"), 1, "applied", None);
}

/// A committed publication of the session, its first turn published.
fn publication(conn: &Connection, id: &str, session: &str, project: &str) {
    conn.execute(
        "INSERT INTO memory_publications(publication_id, project_path, source_session_id, commit_order, committed_at)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(commit_order), 0) + 1 FROM memory_publications), 1)",
        params![id, project, session],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
            session_id, harness, carrier, state, request_json, started_at)
         VALUES (?1, ?2, ?3, 1, 'turn_one', ?4, ?5, 'ck-mc', 'published', '{}', 1)",
        params![
            json!([project, id, 1, "turn_one"]).to_string(),
            project,
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

fn commit_orders(conn: &Connection) -> Vec<(String, i64)> {
    conn.prepare(
        "SELECT publication_id, commit_order FROM memory_publications
         WHERE commit_order IS NOT NULL ORDER BY commit_order",
    )
    .unwrap()
    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn code(refusal: &ErrorBody) -> &str {
    refusal.code.as_str()
}

/// Cut `cut` of the session on `from`, read it on `to`, release it on
/// `from` to `to`, and activate it on `to`.
async fn move_session(from: &Machine, to: &Machine, cut: &str, holder: &str) {
    from.send_out(cut, &["s1"]).await;
    assert_eq!(to.diverged(cut, &["s1"]).await.unwrap(), ["at_cut"]);
    to.op("import", cut, &["s1"]).await.unwrap();
    from.release(cut, &["s1"], holder).await;
    assert_eq!(to.op("activate", cut, &["s1"]).await.unwrap(), json!({}));
}

/// A move installs the session's rows on the receiver as the source held
/// them: the same body, the waiting fact `retryable` with no reservation,
/// the applied fact applied, and its publication queued after the
/// receiver's own, whose commit order it had on the source. Until
/// `activate`, nothing of the import is visible and the session is refused
/// `session_moving`. A move back, with nothing changed on the first
/// machine, answers `at_cut` there and replaces the hidden rows, the
/// publication the first move still holds reserved included, without
/// counting its id as a collision.
#[tokio::test]
async fn a_move_installs_the_session_and_a_move_back_replaces_the_hidden_rows() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    // A publication whose first turn never committed stays behind.
    a.conn()
        .execute_batch(&format!(
            "INSERT INTO memory_publications(publication_id, project_path, source_session_id) VALUES ('pub-open', '{PROJECT}', 's1');
             INSERT INTO memory_stage_attempts(stage_key, project_path, publication_id, run_attempt, stage,
                session_id, harness, carrier, state, request_json, started_at)
             VALUES ('open', '{PROJECT}', 'pub-open', 1, 'turn_one', 's1', '{HARNESS}', 'ck-mc', 'running', '{{}}', 1);"
        ))
        .unwrap();
    seed(&b.conn(), "b1", PROJECT);
    let before = a.fingerprint("s1");
    assert_eq!(commit_orders(&b.conn()), [("pub-b1".to_owned(), 1)]);

    let prepared = a.send_out(CUT, &["s1"]).await;
    assert_eq!(b.diverged(CUT, &["s1"]).await.unwrap(), ["at_cut"]);
    let imported = b.op("import", CUT, &["s1"]).await.unwrap();
    let item = &imported["items"][0];
    for member in ["sessionRef", "endOffset", "digest"] {
        assert_eq!(item[member], prepared["items"][0][member], "{member}");
    }
    assert_eq!(item["dropped"], json!({"uncommitted_publication": 1}));
    assert_eq!(b.status(CUT).await, "imported");
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Staged)));
    assert_eq!(b.fingerprint("s1").rows, 0);
    assert!(
        matches!(b.setup("s1"), Err(ModuleError::Gated(gated)) if gated.code == SESSION_MOVING)
    );
    assert_eq!(b.context_memories("s1").await.unwrap_err(), SESSION_MOVING);
    assert_eq!(b.op("import", CUT, &["s1"]).await.unwrap(), imported);
    a.release(CUT, &["s1"], "machine-b").await;

    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(b.status(CUT).await, "activated");
    assert_eq!(b.fingerprint("s1"), before);
    assert_eq!(b.gate("s1"), Ok(()));
    let entry = b.entry("s1").unwrap();
    assert_eq!(entry.baseline, Some(before.digest.clone()));
    assert_eq!((entry.moving, entry.released), (None, None));
    assert_eq!(facts(&b.conn(), "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(
        commit_orders(&b.conn()),
        [("pub-b1".to_owned(), 1), ("pub-s1".to_owned(), 2)]
    );
    assert!(!source::cut_folder(&b.db, CUT).exists());
    assert_eq!(
        count(
            &b.conn(),
            "SELECT COUNT(*) FROM memory_publications WHERE publication_id = 'pub-open'"
        ),
        0
    );
    // A repeat returns the receipt; the rows are unchanged, so diverged
    // answers at_cut; the install is never undone.
    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(b.diverged(CUT, &["s1"]).await.unwrap(), ["at_cut"]);
    let refused = b.op("abort", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "invalid_state");

    // The first machine still holds its hidden copy, its waiting fact
    // reserved by the first move, and its tombstone.
    assert_eq!(facts(&a.conn(), "pub-s1"), [reserved(0, CUT), applied(1)]);
    assert_eq!(a.gate("s1"), Err(SESSION_MOVED));
    move_session(&b, &a, BACK, "machine-a").await;
    assert_eq!(a.gate("s1"), Ok(()));
    assert_eq!(a.fingerprint("s1"), before);
    assert_eq!(facts(&a.conn(), "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(commit_orders(&a.conn()), [("pub-s1".to_owned(), 1)]);
    let entry = a.entry("s1").unwrap();
    assert_eq!(entry.baseline, Some(before.digest));
    assert_eq!(entry.released, None);
}

/// Once the destination's second turn has decided every waiting fact of a
/// moved publication, the publication no longer travels: a move back still
/// answers `at_cut` and leaves the first machine with no row of it.
#[tokio::test]
async fn a_move_back_drops_the_hidden_copy_of_a_publication_the_destination_decided() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    move_session(&a, &b, CUT, "machine-b").await;
    b.conn()
        .execute(
            "UPDATE memory_pending_facts SET state = 'applied' WHERE publication_id = 'pub-s1'",
            [],
        )
        .unwrap();

    move_session(&b, &a, BACK, "machine-a").await;
    let conn = a.conn();
    for table in [
        "memory_publications",
        "memory_pending_facts",
        "memory_stage_attempts",
    ] {
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM {table} WHERE publication_id = 'pub-s1'")
            ),
            0,
            "{table}"
        );
    }
    assert_eq!(a.fingerprint("s1"), b.fingerprint("s1"));
    assert_eq!(a.fingerprint("s1").rows, 4);
}

/// `diverged`: `advanced` for local rows with no baseline (which import then
/// refuses `local_advanced`, leaving them untouched), for rows of another
/// harness under the session id, and for a row changed since the move;
/// `unknown` when the rows cannot be read; `cut_not_ready` for a cut the
/// door cannot serve yet; `incompatible_version` when this machine's
/// context.db is at another schema version.
#[tokio::test]
async fn diverged_answers_each_state_from_this_machines_rows() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    a.send_out(CUT, &["s1"]).await;

    let refused = b.diverged(THIRD, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "cut_not_ready");
    assert_eq!(
        code(&b.op("import", THIRD, &["s1"]).await.unwrap_err()),
        "cut_not_ready"
    );

    // The same rows as the cut's, but no move ever brought them here.
    seed(&b.conn(), "s1", PROJECT);
    let own = b.fingerprint("s1");
    assert_eq!(b.diverged(CUT, &["s1"]).await.unwrap(), ["advanced"]);
    let refused = b.op("import", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "local_advanced");
    assert_eq!(b.fingerprint("s1"), own);
    assert_eq!(b.status(CUT).await, "none");

    let c = Machine::new(&a.shared);
    c.conn()
        .execute(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at, harness)
             VALUES ('s1', 1, 1, 9, 'other', 'other', 1, 'opencode')",
            [],
        )
        .unwrap();
    assert_eq!(c.fingerprint("s1").rows, 0);
    assert_eq!(c.diverged(CUT, &["s1"]).await.unwrap(), ["advanced"]);

    let d = Machine::new(&a.shared);
    d.conn().execute_batch("DROP TABLE notes").unwrap();
    assert_eq!(d.diverged(CUT, &["s1"]).await.unwrap(), ["unknown"]);

    let e = Machine::new(&a.shared);
    e.conn()
        .execute(
            "INSERT INTO schema_migrations(version, description, applied_at) VALUES (999, 'newer', 0)",
            [],
        )
        .unwrap();
    for op in ["diverged", "import"] {
        let refused = e.op(op, CUT, &["s1"]).await.unwrap_err();
        assert_eq!(code(&refused), "incompatible_version", "{op}");
    }
    assert!(!source::cut_folder(&e.db, CUT).exists());

    // After a move, a row changed on the receiver is local data the cut
    // does not hold.
    let f = Machine::new(&a.shared);
    f.op("import", CUT, &["s1"]).await.unwrap();
    f.op("activate", CUT, &["s1"]).await.unwrap();
    assert_eq!(f.diverged(CUT, &["s1"]).await.unwrap(), ["at_cut"]);
    f.conn()
        .execute(
            "UPDATE notes SET content = 'edited' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    assert_eq!(f.diverged(CUT, &["s1"]).await.unwrap(), ["advanced"]);
}

/// `import` is `busy` while the session runs here, and is not for a
/// session released from here, which a move back brings home.
#[tokio::test]
async fn import_is_busy_for_a_session_that_runs_here() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    a.send_out(CUT, &["s1"]).await;
    b.setup("s1").unwrap();
    let refused = b.op("import", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "busy");
    assert_eq!(
        refused.detail.unwrap()["refs"][0]["reason_code"],
        "run_active"
    );
    assert_eq!(b.status(CUT).await, "none");
    assert_eq!(b.moving("s1"), None);
}

/// A snapshot this store cannot hold as it is, a NOT NULL column without a
/// value or a fact naming no publication, is refused `incompatible_version`
/// naming the table, and nothing is staged.
#[tokio::test]
async fn import_refuses_rows_this_store_cannot_hold_before_staging() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    let encoded = snapshot::read(&mut a.conn(), &key("s1")).unwrap();
    let decoded = snapshot::decode(&encoded.bytes).unwrap();
    let session_ref = source::session_ref(&key("s1"));
    for (cut, table, column) in [
        (CUT, "compartments", "content"),
        (BACK, "memory_pending_facts", "publication_id"),
    ] {
        let mut rows = decoded.rows.clone();
        let index = moved::MOVED
            .iter()
            .position(|moved| moved.name == table)
            .unwrap();
        rows.tables[index][0].insert(column.to_owned(), Value::Null);
        let bytes = snapshot::encode(&key("s1"), encoded.header.schema_version, &rows).bytes;
        {
            let mut door = a.shared.door.lock().unwrap();
            door.streams.insert(session_ref.clone(), bytes.clone());
            door.sealed.insert(
                (cut.to_owned(), session_ref.clone()),
                (bytes.len(), sha256(&bytes)),
            );
        }
        let refused = b.op("import", cut, &["s1"]).await.unwrap_err();
        assert_eq!(code(&refused), "incompatible_version", "{table}");
        assert!(refused.message.contains(table), "{}", refused.message);
        assert!(!source::cut_folder(&b.db, cut).exists());
        assert_eq!(b.status(cut).await, "none");
        assert_eq!(b.gate("s1"), Ok(()));
    }
}

use crate::agent_data::moved;

/// A store that still guards the session's project against writes, left
/// by the removed Rust transform mode, refuses the install before anything
/// is staged: no plan, no staged file and no changed row. Without the
/// guard row the same store installs the session.
#[tokio::test]
async fn an_install_into_a_project_with_write_guards_is_refused_before_staging() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    seed(&b.conn(), "b1", PROJECT);
    a.send_out(CUT, &["s1"]).await;
    b.conn()
        .execute(
            "INSERT INTO authority_managed(project_path, context_store_uuid, marked_at) VALUES (?1, 'store', 1)",
            [PROJECT],
        )
        .unwrap();
    let before = count(&b.conn(), "SELECT COUNT(*) FROM notes")
        + count(&b.conn(), "SELECT COUNT(*) FROM compartments");

    let refused = b.op("import", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "participant_failed");
    assert_eq!(
        refused.detail.as_ref().unwrap()["reason"],
        receiver::PROJECT_WRITES_GUARDED
    );
    assert!(
        refused.message.contains("removed Rust transform mode")
            && refused.message.contains(PROJECT),
        "{}",
        refused.message
    );
    assert!(!source::cut_folder(&b.db, CUT).exists());
    assert_eq!(
        count(
            &b.conn(),
            "SELECT COUNT(*) FROM schema_migrations_meta WHERE key LIKE 'agent_data_install:%'"
        ),
        0
    );
    assert_eq!(
        count(&b.conn(), "SELECT COUNT(*) FROM notes")
            + count(&b.conn(), "SELECT COUNT(*) FROM compartments"),
        before
    );
    assert_eq!(b.status(CUT).await, "none");

    b.conn()
        .execute("DELETE FROM authority_managed", [])
        .unwrap();
    b.op("import", CUT, &["s1"]).await.unwrap();
    b.op("activate", CUT, &["s1"]).await.unwrap();
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
}

/// An abort before `activate` deletes the staged snapshot and lifts the
/// staged gate, and keeps the cut's record, the tombstone the session had
/// here and its baseline.
#[tokio::test]
async fn an_abort_before_activate_drops_the_staging_and_keeps_the_tombstone() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    move_session(&a, &b, CUT, "machine-b").await;
    let tombstoned = a.entry("s1").unwrap();
    let hidden = a.fingerprint("s1");

    b.send_out(BACK, &["s1"]).await;
    a.op("import", BACK, &["s1"]).await.unwrap();
    assert_eq!(a.gate("s1"), Err(SESSION_MOVING));
    assert_eq!(a.context_memories("s1").await.unwrap_err(), SESSION_MOVING);
    assert!(source::cut_folder(&a.db, BACK).exists());

    assert_eq!(a.op("abort", BACK, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(a.status(BACK).await, "aborted");
    assert!(!source::cut_folder(&a.db, BACK).exists());
    assert_eq!(a.entry("s1").unwrap(), tombstoned);
    assert_eq!(a.gate("s1"), Err(SESSION_MOVED));
    assert_eq!(a.fingerprint("s1"), hidden);
    // The abort is repeatable. A repeat of the import replays its reply,
    // as every repeat does, and stages nothing again.
    assert_eq!(a.op("abort", BACK, &["s1"]).await.unwrap(), json!({}));
    a.op("import", BACK, &["s1"]).await.unwrap();
    assert_eq!(a.gate("s1"), Err(SESSION_MOVED));
    assert!(!source::cut_folder(&a.db, BACK).exists());
    assert_eq!(a.status(BACK).await, "aborted");
}

/// `activate` checks the staged bytes and the rows here again before it
/// records anything: a row added here since the import is refused
/// `local_advanced` and left as it is, and a staged file that changed is
/// refused `digest_mismatch`. Both leave the session staged.
#[tokio::test]
async fn activate_rechecks_the_staged_bytes_and_the_rows_here() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    a.send_out(CUT, &["s1"]).await;
    b.op("import", CUT, &["s1"]).await.unwrap();

    b.conn()
        .execute(
            "INSERT INTO session_projects(session_id, harness, project_path, updated_at) VALUES ('s1', ?1, ?2, 5)",
            params![HARNESS, OTHER_PROJECT],
        )
        .unwrap();
    let refused = b.op("activate", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "local_advanced");
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Staged)));
    assert_eq!(b.fingerprint("s1").rows, 1);
    b.conn()
        .execute("DELETE FROM session_projects", [])
        .unwrap();

    let file = receiver::staged_file(&b.db, CUT, &source::session_ref(&key("s1")));
    let staged = std::fs::read(&file).unwrap();
    let mut changed = staged.clone();
    *changed.last_mut().unwrap() = b' ';
    std::fs::write(&file, &changed).unwrap();
    let refused = b.op("activate", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "digest_mismatch");
    assert_eq!(
        refused
            .digest_mismatch_detail()
            .unwrap()
            .unwrap()
            .reason
            .as_deref(),
        Some("staging_digest_mismatch")
    );
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Staged)));

    std::fs::write(&file, &staged).unwrap();
    b.op("activate", CUT, &["s1"]).await.unwrap();
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
}

/// Hold `mode3.db`'s write lock, as another writer would, so the store's
/// zero busy timeout refuses its next write.
fn hold_store(machine: &Machine) -> Connection {
    let conn = Connection::open(machine.dir.path().join("mode3.db")).unwrap();
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    conn
}

/// An install that fails after it was recorded, here at the `mode3.db`
/// clear, leaves the session being installed and gated, with no receipt;
/// the abort is refused. A repeat of `activate` finishes it, and a repeat
/// after that returns the receipt.
#[tokio::test]
async fn an_install_cut_short_is_finished_by_a_repeat_and_never_aborted() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    seed(&b.conn(), "s1", PROJECT);
    // The receiver's copy is at the cut: it is the one the source moved.
    let baseline = b.fingerprint("s1").digest;
    b.module
        .journal()
        .change(|contents| {
            contents.session_mut(RUNNER, HARNESS, "s1").baseline = Some(baseline);
        })
        .unwrap();
    a.conn()
        .execute(
            "UPDATE notes SET content = 'newer' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    a.send_out(CUT, &["s1"]).await;
    b.op("import", CUT, &["s1"]).await.unwrap();

    let lock = hold_store(&b);
    let refused = b.op("activate", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "unavailable");
    assert!(refused.message.contains("mode3.db"), "{}", refused.message);
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Activating)));
    assert_eq!(b.status(CUT).await, "imported");
    assert_eq!(b.gate("s1"), Err(SESSION_MOVING));
    // The install itself is done, and the facts stay reserved until step 6.
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
    assert_eq!(facts(&b.conn(), "pub-s1"), [reserved(0, CUT), applied(1)]);
    let record = b.module.journal().contents().unwrap().cuts[CUT].clone();
    assert!(record.activate_request.is_some());
    assert_eq!(record.undo_images.len(), 1);
    assert_eq!(
        code(&b.op("abort", CUT, &["s1"]).await.unwrap_err()),
        "invalid_state"
    );

    drop(lock);
    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(b.status(CUT).await, "activated");
    assert_eq!(facts(&b.conn(), "pub-s1"), [waiting(0), applied(1)]);
    let entry = b.entry("s1").unwrap();
    assert_eq!(entry.baseline, Some(a.fingerprint("s1").digest));
    assert_eq!(entry.moving, None);
    assert!(b.module.journal().contents().unwrap().cuts[CUT]
        .activate_request
        .is_none());
    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
}

/// The facts a second turn of the project sends for `publication`: its own
/// `retryable` facts, then the backlog of every other committed
/// publication's `retryable` facts. These are the two queries of the
/// second turn's fact selection (`select_facts` in
/// `summary/two_pass/turn_two.rs`), without its backlog limit.
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

/// The install inserts the moved session's waiting facts reserved under
/// the cut's key, and they stay reserved until `activate` lets them go
/// after the install. A second turn of another session of the project that
/// runs meanwhile, here while `activate` is stopped after the install,
/// sends none of them and still sends its own. Once `activate` finishes,
/// the next second turn takes them up as backlog, after the receiver's own.
#[tokio::test]
async fn a_second_turn_during_the_install_sends_none_of_the_moved_facts() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    seed(&b.conn(), "b1", PROJECT);
    a.send_out(CUT, &["s1"]).await;
    b.op("import", CUT, &["s1"]).await.unwrap();
    a.release(CUT, &["s1"], "machine-b").await;

    let lock = hold_store(&b);
    let refused = b.op("activate", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(code(&refused), "unavailable");
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Activating)));
    assert_eq!(b.fingerprint("s1"), a.fingerprint("s1"));
    assert_eq!(facts(&b.conn(), "pub-s1"), [reserved(0, CUT), applied(1)]);
    assert_eq!(second_turn(&b.conn(), "pub-b1"), ["fact pub-b1 0"]);

    drop(lock);
    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
    assert_eq!(
        second_turn(&b.conn(), "pub-b1"),
        ["fact pub-b1 0", "fact pub-s1 0"]
    );
}

/// A restart finishes an install the last run recorded as started, in a
/// build that does not serve moves too, and writes the receipt the
/// driver's repeat then gets back. Nothing of the finished cut runs again
/// at the next start.
#[tokio::test]
async fn a_restart_finishes_an_install_the_last_run_started() {
    let (a, b) = machines(&["s1"]);
    seed(&a.conn(), "s1", PROJECT);
    a.send_out(CUT, &["s1"]).await;
    b.op("import", CUT, &["s1"]).await.unwrap();
    let lock = hold_store(&b);
    b.op("activate", CUT, &["s1"]).await.unwrap_err();
    assert_eq!(b.moving("s1"), Some((CUT.into(), MovingState::Activating)));
    drop(lock);

    let b = b.restart().await;
    assert_eq!(b.status(CUT).await, "activated");
    assert_eq!(b.gate("s1"), Ok(()));
    assert_eq!(facts(&b.conn(), "pub-s1"), [waiting(0), applied(1)]);
    assert_eq!(b.op("activate", CUT, &["s1"]).await.unwrap(), json!({}));
    // A later turn's mode3.db rows survive the next start.
    b.module
        .inner
        .store
        .as_ref()
        .unwrap()
        .save(&key("s1"), &crate::store::Durable::default())
        .unwrap();
    let b = b.restart().await;
    assert!(b
        .module
        .inner
        .store
        .as_ref()
        .unwrap()
        .load(&key("s1"))
        .is_some());
}

/// Right after `activate`, with no Setup between, a context read takes the
/// session's project from the installed project link, not from a project
/// this process cached for the session before: the changed link's
/// memories, or none once the link is gone.
#[tokio::test]
async fn context_reads_take_the_installed_project_link_right_after_activate() {
    for link in [Some(OTHER_PROJECT), None] {
        let (a, b) = machines(&["s1"]);
        seed(&a.conn(), "s1", link.unwrap_or(PROJECT));
        if link.is_none() {
            a.conn()
                .execute("DELETE FROM session_projects", [])
                .unwrap();
        }
        for (id, project, content) in [
            (1, PROJECT, "old project fact"),
            (2, OTHER_PROJECT, "new project fact"),
        ] {
            b.conn()
                .execute(
                    "INSERT INTO memories(id, level, owner_id, category, origin_category, content, normalized_hash, shareable, scope, importance,
                        status, expires_at, first_seen_at, created_at, updated_at, last_seen_at)
                     VALUES (?1, 'project', ?2, 'swe:project-rules', 'PROJECT_RULES', ?3, ?4, 1, 'project', 80, 'active', NULL, 0, 0, 0, 0)",
                    params![id, project, content, format!("hash-{id}")],
                )
                .unwrap();
        }
        // A project this process cached for the session before the move.
        b.module.inner.session_projects.lock().unwrap().insert(
            key("s1"),
            crate::route::Project {
                id: PROJECT.into(),
                root: "/work/proj".into(),
            },
        );
        move_session(&a, &b, CUT, "machine-b").await;
        let expected: Vec<String> = link
            .map(|_| vec!["new project fact".to_owned()])
            .unwrap_or_default();
        assert_eq!(
            b.context_memories("s1").await.unwrap(),
            expected,
            "{link:?}"
        );
    }
}

/// A cut of two sessions stages, installs and activates both, each with
/// its own baseline and its own facts made `retryable`.
#[tokio::test]
async fn a_cut_of_two_sessions_installs_both() {
    let (a, b) = machines(&["s1", "s2"]);
    seed(&a.conn(), "s1", PROJECT);
    seed(&a.conn(), "s2", PROJECT);
    let both = ["s1", "s2"];
    a.send_out(CUT, &both).await;
    assert_eq!(b.diverged(CUT, &both).await.unwrap(), ["at_cut", "at_cut"]);
    let imported = b.op("import", CUT, &both).await.unwrap();
    assert_eq!(imported["items"].as_array().unwrap().len(), 2);
    a.release(CUT, &both, "machine-b").await;
    b.op("activate", CUT, &["s2", "s1"]).await.unwrap();
    for session in both {
        assert_eq!(b.fingerprint(session), a.fingerprint(session), "{session}");
        assert_eq!(
            b.entry(session).unwrap().baseline,
            Some(a.fingerprint(session).digest)
        );
        assert_eq!(
            facts(&b.conn(), &format!("pub-{session}")),
            [waiting(0), applied(1)]
        );
        assert_eq!(b.gate(session), Ok(()));
    }
}

/// A projection the app reads serve, with `marker` in its meta.
fn projection(session: SessionRef, marker: &str) -> crate::app_read::Snapshot {
    crate::app_read::Snapshot {
        key: session,
        base: 0,
        newest: 0,
        ready: true,
        meta: json!({"marker": marker}),
        breakdown: Default::default(),
        compartments: Vec::new(),
        messages: Default::default(),
        decisions: Vec::new(),
    }
}

/// The marker of the session's projection, or the app reads' refusal.
async fn app_meta(machine: &Machine, session: &SessionRef) -> Result<Value, String> {
    machine
        .module
        .app_read()
        .read(
            "session_data.read",
            json!({"session": session, "section": "meta"}),
        )
        .await
        .map(|reply| reply["row"]["marker"].clone())
        .map_err(|refusal| refusal.code)
}

/// The app reads hold nothing of a session from before a move once the
/// move installs another machine's copy over it, under the session's
/// runner or another runner of the same harness and session: until its
/// next Setup the session is answered as one this process never saw. The
/// same holds on the source once it releases the session. Another
/// session's projection is left as it was.
#[tokio::test]
async fn the_app_reads_hold_nothing_of_a_session_a_move_replaced_or_released() {
    for runner in [RUNNER, "other-runner"] {
        let (a, b) = machines(&["s1"]);
        seed(&a.conn(), "s1", PROJECT);
        let earlier = SessionRef::new(runner, HARNESS, "s1");
        // What b projected of the session while it ran there before.
        b.module
            .app_read()
            .publish(projection(earlier.clone(), "earlier"));
        b.module.app_read().publish(projection(key("b1"), "b1"));
        a.module.app_read().publish(projection(key("s1"), "source"));
        assert_eq!(app_meta(&b, &earlier).await, Ok(json!("earlier")));
        assert_eq!(app_meta(&a, &key("s1")).await, Ok(json!("source")));

        move_session(&a, &b, CUT, "machine-b").await;
        let never_seen = app_meta(&b, &key("never-seen")).await.unwrap_err();
        assert_eq!(never_seen, "session_not_found");
        for session in [&earlier, &key("s1")] {
            assert_eq!(
                app_meta(&b, session).await,
                Err(never_seen.clone()),
                "{runner}"
            );
            let refused = b
                .module
                .app_request(
                    "session_data.read",
                    json!({"session": session, "section": "meta"}),
                )
                .await
                .unwrap_err();
            assert_eq!(refused.code, never_seen, "{runner}");
        }
        assert_eq!(app_meta(&b, &key("b1")).await, Ok(json!("b1")));
        // Past the source's gate, which refuses the session session_moved.
        assert_eq!(app_meta(&a, &key("s1")).await, Err(never_seen));
    }
}

#[path = "crash_tests.rs"]
mod crash_tests;

#[cfg(feature = "context-db-timing")]
#[path = "install_lock_tests.rs"]
mod install_lock_tests;
