//! A move as the session's runner sees it. One mock-runner session is
//! served by ck-mc on one machine, moved to another machine through the
//! agent-data ops, and then served there. A runner moves a session with
//! its transcript and its applied view unchanged, and never sends a Setup
//! during its own move, so the runner session here stays the same object
//! throughout. Only the module it calls changes.

use super::*;
use crate::agent_data::journal as journal_file;
use crate::agent_data::{door, Journal};
use crate::client::{Child, ClientError, DoorRefusal, EntorhinalRefusal};
use crate::routing::RouteError;
use cortexkit_role_agent_data::errors::ErrorBody;
use cortexkit_role_compaction::read::{ReadPage, ReadRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{CallError, Host, Provider, Runner, SessionConfig, UserEdit};
use mc_mock_runner::script::{Step, ToolCall, Turn};
use rusqlite::Connection;
use serde_json::json;
use sha2::{Digest, Sha256};

const ENTORHINAL: &str = "reserved:entorhinal";
const CUT: &str = "0123456789abcdef0123456789abcdef";
const RUNNER: &str = "thalamus-harness";
const HARNESS: &str = "pi";
const SESSION: &str = "s1";
const PROJECT: &str = "git:proj";
const ROOT: &str = "/work/proj";

/// Engram's session door, shared by both machines: one append-only stream
/// per session, and the cuts Entorhinal sealed, each with its end and
/// digest per session.
#[derive(Default)]
struct Door {
    streams: HashMap<String, Vec<u8>>,
    sealed: HashMap<(String, String), (usize, String)>,
}

/// What both machines reach: the runner session, Entorhinal's bindings and
/// the door.
#[derive(Default)]
struct Shared {
    /// The runner's side of the session, attached once the runner started.
    host: Mutex<Option<Host>>,
    bindings: Mutex<HashMap<String, Value>>,
    door: Mutex<Door>,
}

/// One machine's ck-mc client: the shared runner, Entorhinal and door, and
/// the versions of the views this machine's ck-mc offered the runner.
#[derive(Clone)]
struct Client {
    shared: Arc<Shared>,
    offered: Arc<Mutex<Vec<u64>>>,
}

impl Client {
    fn host(&self) -> Result<Host, ClientError> {
        self.shared
            .host
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ClientError::new("runner not attached"))
    }
}

/// A request as the runner decodes it from its JSON.
fn through_wire<T: serde::Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    serde_json::from_value(serde_json::to_value(value).unwrap()).unwrap()
}

/// An llm-runner answer as ck-mc reads it: wrapped as `{"result": ...}`.
fn read_wrapped<T: serde::Serialize, A: serde::de::DeserializeOwned>(
    answer: &T,
) -> Result<A, ClientError> {
    let body = cortexkit_role_llm_runner::wire::reply_body(answer).unwrap();
    cortexkit_role_llm_runner::wire::read_reply(&body)
        .map_err(|error| ClientError::new(format!("{error:?}")))
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        self.host()?
            .read(&request)
            .map_err(|refusal| ClientError::new(format!("{refusal:?}")))
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        self.offered.lock().unwrap().push(request.view.version);
        Ok(self.host()?.apply_view(request))
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(self.host()?.applied_view())
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        let reply = self
            .host()?
            .send(&session.session, through_wire(&request))
            .map_err(|refusal| ClientError::new(format!("{refusal:?}")))?;
        read_wrapped(&reply)
    }

    async fn send_child(
        &self,
        child: &Child,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        self.send(&child.session, request).await
    }

    async fn child_result(
        &self,
        _: &Child,
        request: RunResultRequest,
    ) -> Result<RunResult, ClientError> {
        let result = self
            .host()?
            .run_result(&through_wire(&request))
            .ok_or_else(|| ClientError::new(format!("unknown run {}", request.run_id)))?;
        read_wrapped(&result)
    }

    /// Entorhinal answers the move's ref lookups, and no memory-context read.
    async fn entorhinal_call(
        &self,
        _: &SessionRef,
        body: Vec<u8>,
    ) -> Option<Result<Vec<u8>, EntorhinalRefusal>> {
        let request: Value = serde_json::from_slice(&body).unwrap();
        if request["method"] != "agent.session_for_ref" {
            return None;
        }
        let reference = request["params"]["ref"].as_str().unwrap();
        let found = self.shared.bindings.lock().unwrap().get(reference).cloned();
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
        let mut door = self.shared.door.lock().unwrap();
        let session = params["sessionRef"].as_str().unwrap().to_owned();
        let stream = door.streams.get(&session).cloned().unwrap_or_default();
        match method {
            "session.offsets" => {
                Ok(json!({"durableOffset": stream.len(), "cloudOffset": stream.len()}))
            }
            "session.admit" => {
                let from = params["fromOffset"].as_u64().unwrap() as usize;
                assert_eq!(from, stream.len(), "admit resumes at the stream's end");
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
                let (end, digest) = door.sealed[&(cut.to_owned(), session)].clone();
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

/// A stand-in routing provider: the session's own model, with a window the
/// summarizer's prompt fits in.
impl Router for Client {
    async fn select(&self, request: SelectRequest) -> Result<SelectAnswer, RouteError> {
        let route = RouteRef::new("test", "test-model");
        let runner = RunnerRef::new(
            request.runners.unwrap_or_default()[0].clone(),
            route.clone(),
        );
        Ok(SelectAnswer::new(
            "d1".to_owned(),
            route,
            runner,
            400_000,
            32_000,
            u64::MAX,
            "test",
        ))
    }

    async fn report(&self, _: ReportRequest) {}
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

/// One machine: ck-mc over its own stores in a temporary folder.
struct Machine {
    module: Module<Client>,
    offered: Arc<Mutex<Vec<u64>>>,
    db: std::path::PathBuf,
    _dir: tempfile::TempDir,
}

impl Machine {
    fn new(shared: &Arc<Shared>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("context.db");
        let context = ContextDb::create_for_tests(&db).unwrap();
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let journal = Arc::new(Journal::load(journal_file::path(&db)));
        let offered = Arc::new(Mutex::new(Vec::new()));
        let client = Client {
            shared: Arc::clone(shared),
            offered: Arc::clone(&offered),
        };
        let module = Module::with_journal(
            client,
            Settings::default(),
            Some(context),
            Some(store),
            journal,
            true,
        );
        Self {
            module,
            offered,
            db,
            _dir: dir,
        }
    }

    async fn op(&self, op: &str, extra: Value) -> Result<Value, ErrorBody> {
        let mut params =
            json!({"refs": [{"ref_kind": "pi-session", "ref": SESSION}], "cutId": CUT});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let body =
            serde_json::to_vec(&json!({"method": format!("agent_data.{op}"), "params": params}))
                .unwrap();
        let reply = self.module.agent_data(ENTORHINAL, &body).await?;
        Ok(serde_json::from_slice(&reply).unwrap())
    }

    fn conn(&self) -> Connection {
        Connection::open(&self.db).unwrap()
    }
}

/// The runner's provider: ck-mc on whichever machine holds the session,
/// as the runner's routes reach it in process.
struct Serving {
    module: Mutex<Module<Client>>,
    route: Route,
}

impl Serving {
    fn module(&self) -> Module<Client> {
        self.module.lock().unwrap().clone()
    }
}

fn call_error(error: ModuleError) -> CallError {
    use cortexkit_role_compaction::wire::codes;
    match error {
        ModuleError::UnknownSession => CallError::refused(codes::UNKNOWN_SESSION, "no Setup"),
        ModuleError::Gated(gated) => CallError::refused(gated.code, gated.message),
        other => CallError::new(format!("{other:?}")),
    }
}

impl Provider for Serving {
    async fn compaction_provides(&self) -> Result<Vec<String>, CallError> {
        Ok(crate::transport::manifest("ck-mc")
            .capabilities
            .unwrap()
            .provides)
    }

    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.module()
            .setup(self.route.clone(), request)
            .map_err(call_error)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        let module = self.module();
        let answer = module
            .notice(&self.route.session, request)
            .map_err(call_error)?;
        if answer == NoticeAnswer::Received {
            module.idle(&self.route.session).await.map_err(call_error)?;
        }
        Ok(answer)
    }

    async fn ride(&self, request: RideRequest) -> Result<RideAnswer, CallError> {
        self.module()
            .ride(&self.route.session, request)
            .await
            .map_err(call_error)
    }

    async fn tool(&self, name: &str, input: &Value) -> Result<String, CallError> {
        self.module()
            .tool(&self.route, name, input.clone())
            .await
            .map_err(call_error)
    }

    async fn pre_user(&self, _text: &str, _now: u64) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

fn large_read() -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(50),
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(48_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn answer() -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        output_tokens: 5,
        ..Turn::default()
    })
}

fn config() -> SessionConfig {
    SessionConfig {
        session: SessionRef::new(RUNNER, HARNESS, SESSION),
        preset: "head".into(),
        model: ModelRef::new("test", "test-model"),
        context_window: 100_000,
        output_reserve: 1_000,
        rules: ProviderRules::new(SignedParts::None, EditCost::Suffix),
        kind: Kind::OpenAi,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: Some(mc_mock_runner::runner::Project {
            id: PROJECT.into(),
            root: ROOT.into(),
        }),
        model_latency_ms: 0,
        templates: crate::nudges::templates(),
        accepts_images: None,
        view_anchor: true,
    }
}

fn summaries(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM compartments WHERE session_id = ?1 AND harness = ?2",
        [SESSION, HARNESS],
        |row| row.get(0),
    )
    .unwrap()
}

/// After a move, the destination's first Setup for the session, with the
/// transcript and the applied view the runner kept, produces no new view:
/// it reconciles the moved summaries with the transcript and adopts the
/// runner's view. The next request is rendered from the same view as
/// before the move.
#[tokio::test]
async fn the_first_setup_after_a_move_adopts_the_runners_view_and_offers_none() {
    let shared = Arc::new(Shared::default());
    shared.bindings.lock().unwrap().insert(
        SESSION.to_owned(),
        json!({
            "agent_id": "agent_0000000000000101",
            "ref_kind": "pi-session",
            "ref": SESSION,
            "harness": HARNESS,
            "session_id": SESSION,
            "project_root": ROOT,
            "incarnation": "0123456789abcdef",
            "runner": RUNNER,
        }),
    );
    let a = Machine::new(&shared);
    let b = Machine::new(&shared);
    let session = SessionRef::new(RUNNER, HARNESS, SESSION);
    let provider = Serving {
        module: Mutex::new(a.module.clone()),
        route: Route {
            session: session.clone(),
            project: Some(crate::route::Project {
                id: PROJECT.into(),
                root: ROOT.into(),
            }),
            workdir: Some(ROOT.into()),
            agent_id: None,
        },
    };
    let mut runner = Runner::start(config(), provider).await.unwrap();
    *shared.host.lock().unwrap() = Some(runner.host().clone());

    // Three turns take the head over its threshold: the summarizer writes
    // summaries, and a view shows them in place of the messages.
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend([user(prompt), large_read(), large_read(), answer()]);
    }
    steps.extend([answer(), answer()]);
    runner.play(&steps).await;
    assert!(runner.report.model_errors.is_empty());
    assert!(runner.report.refusals.is_empty());
    assert!(runner.report.view_refusals.is_empty());
    assert!(summaries(&a.conn()) > 0, "the summarizer wrote no summary");
    let applied = runner.host().applied_version().expect("a view was applied");
    assert!(!a.offered.lock().unwrap().is_empty());

    // The source's busy check waits for the runner to confirm the view it
    // was offered last; a step confirms it.
    let mut prepared = None;
    for _ in 0..5 {
        match a.op("prepare", json!({})).await {
            Ok(reply) => {
                prepared = Some(reply);
                break;
            }
            Err(refusal) if refusal.code.as_str() == "busy" => runner.play(&[answer()]).await,
            Err(refusal) => panic!("prepare refused: {refusal:?}"),
        }
    }
    let prepared = prepared.expect("the session never stopped being busy");
    for item in prepared["items"].as_array().unwrap() {
        shared.door.lock().unwrap().sealed.insert(
            (
                CUT.to_owned(),
                item["sessionRef"].as_str().unwrap().to_owned(),
            ),
            (
                item["endOffset"].as_u64().unwrap() as usize,
                item["digest"].as_str().unwrap().to_owned(),
            ),
        );
    }
    let applied_at_cut = runner.host().applied_version();
    let requests_at_cut = runner.report.requests.len();
    let view_at_cut = runner.report.requests.last().unwrap().view;
    assert_eq!(view_at_cut, applied_at_cut);
    assert!(applied_at_cut >= Some(applied));
    a.op("export", json!({})).await.unwrap();
    assert_eq!(
        b.op("diverged", json!({})).await.unwrap()["refs"][0]["state"],
        "at_cut"
    );
    b.op("import", json!({})).await.unwrap();
    a.op("release", json!({"holder": "machine-b"}))
        .await
        .unwrap();
    b.op("activate", json!({})).await.unwrap();
    assert_eq!(
        crate::agent_data::snapshot::fingerprint(&b.conn(), HARNESS, SESSION).unwrap(),
        crate::agent_data::snapshot::fingerprint(&a.conn(), HARNESS, SESSION).unwrap()
    );

    // The runner's routes now reach the destination. Its first notice is
    // answered `setup_required`, and the runner's Setup carries the same
    // transcript and applied view.
    *runner.provider().module.lock().unwrap() = b.module.clone();
    runner.play(&[user("Carry on."), answer()]).await;
    assert!(runner.report.model_errors.is_empty());
    assert!(runner.report.refusals.is_empty());
    assert!(runner.report.view_refusals.is_empty());
    assert!(
        b.offered.lock().unwrap().is_empty(),
        "the destination offered views {:?}",
        b.offered.lock().unwrap()
    );
    assert_eq!(runner.host().applied_version(), applied_at_cut);
    let after = &runner.report.requests[requests_at_cut..];
    assert!(!after.is_empty());
    assert!(
        after.iter().all(|record| record.view == view_at_cut),
        "{after:?}"
    );
    // The destination served the session from the moved summaries.
    assert_eq!(summaries(&b.conn()), summaries(&a.conn()));
    assert!(b.module.inner.set_up.lock().unwrap().contains_key(&session));

    // The destination carries on from the adopted view: once the session
    // is over its threshold again, its next views follow the runner's
    // applied one, and the runner accepts them.
    let mut steps = Vec::new();
    for prompt in ["Look at d.rs.", "Now e.rs.", "And f.rs."] {
        steps.extend([user(prompt), large_read(), large_read(), answer()]);
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert!(runner.report.model_errors.is_empty());
    assert!(runner.report.view_refusals.is_empty());
    let offered = b.offered.lock().unwrap().clone();
    assert!(!offered.is_empty(), "the destination never offered a view");
    assert!(
        offered
            .iter()
            .all(|version| Some(*version) > applied_at_cut),
        "{offered:?} after {applied_at_cut:?}"
    );
    assert!(runner.host().applied_version() > applied_at_cut);
}
