//! The resident path against the full-recompute oracle.
//!
//! Two providers, each with its own store, receive the same randomized
//! operations on the same transcript: one keeps conversations resident and
//! skips engine passes that cannot publish; the oracle rebuilds every
//! conversation from rows, runs the engine on every notice and computes every
//! aggregate by a full scan. After every step the published views, their
//! versions and every answer (notice outcome, ride, `ctx_reduce`, `view.get`)
//! must be byte-identical.
use super::*;
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};

#[path = "stack24_cache_review.rs"]
mod stack24_cache_review;

#[path = "stack26_cache_review.rs"]
mod stack26_cache_review;

#[path = "card_cache_review.rs"]
mod card_cache_review;

#[path = "cut_lineage_tests.rs"]
mod cut_lineage_tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Profile {
    Broca,
    OpenCode,
    Pi,
    Anthropic,
}

const PROFILES: [Profile; 4] = [
    Profile::Broca,
    Profile::OpenCode,
    Profile::Pi,
    Profile::Anthropic,
];

impl Profile {
    fn wire(self) -> &'static str {
        match self {
            Self::Broca => "owned-broca",
            Self::OpenCode => "opencode-aisdk",
            Self::Pi => "pi",
            Self::Anthropic => "anthropic-messages",
        }
    }

    fn harness(self) -> &'static str {
        match self {
            Self::Broca => "broca",
            Self::OpenCode => "opencode",
            Self::Pi => "pi",
            Self::Anthropic => "claude-code",
        }
    }
}

/// A small deterministic generator (xorshift64*).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

fn output(n: u64, salt: u64) -> String {
    let words = match (n + salt) % 7 {
        0 => 600,
        1 | 2 => 40,
        _ => 140,
    };
    format!("output {n}.{salt} ") + &"spent tool output line ".repeat(words)
}

fn tag(n: u64, part: u64) -> String {
    format!("§{}§", 100 + n * 4 + part)
}

/// Number the transcript as an llm-runner 0.4.0 runner with no anchor does:
/// each counted part (a row the fixture tags) is numbered from zero by its
/// position (`tags::number_parts`), whatever number the fixture wrote. The
/// fixtures never reshape a message the runner already served, so a part's
/// number changes only when the transcript before it does, which they pair
/// with a new lineage or a cut.
fn renumber(entries: &mut [ReadMessage]) {
    let counted = entries
        .iter()
        .flat_map(|entry| &entry.tags)
        .filter(|row| row.tag.is_some())
        .count();
    let parts = (0..counted as u64)
        .map(|at| tags::RenderedPart::new(tags::PartKind::ToolResultText, at))
        .collect::<Vec<_>>();
    let mut numbers = tags::try_number_parts(0, &parts).unwrap().into_iter();
    for row in entries
        .iter_mut()
        .flat_map(|entry| entry.tags.iter_mut())
        .filter(|row| row.tag.is_some())
    {
        row.tag = numbers.next().flatten().and_then(tags::format_tag);
    }
}

/// Message `n` of a transcript in `profile`'s schema. `salt` changes its
/// bytes (a rewritten message) without changing its shape. Non-OpenCode
/// schemas repeat a four-message turn: a user prompt, an assistant message
/// with a tool call, the tool's result, an answer. Every twelfth turn's tool
/// is `todowrite`.
fn message(profile: Profile, n: u64, salt: u64) -> ReadMessage {
    let tool = if n % 48 == 1 { "todowrite" } else { "read" };
    let input = if tool == "todowrite" {
        json!({"todos":[{"content":format!("task {n}"),"status":"in_progress","priority":"high","id":format!("t{n}")}]})
    } else {
        json!({"path":format!("src/file{n}.rs")})
    };
    let text = |kind: &str| format!("{kind} {n}.{salt} ") + &"durable words ".repeat(12);
    let tagged = |part: u64| tags::PartTag::tagged(part.to_string(), tag(n, part));
    let untagged = |part: u64| tags::PartTag::untagged(part.to_string());
    let call = format!("call{}", n - n % 4 + 1);
    let (message, rows) = match profile {
        Profile::OpenCode => {
            if n.is_multiple_of(5) {
                (
                    json!({"info":{"id":format!("m{n}"),"role":"user","time":{"created":1}},"parts":[{"id":format!("p{n}a"),"type":"text","text":text("user")}]}),
                    vec![tagged(0)],
                )
            } else {
                (
                    json!({"info":{"id":format!("m{n}"),"role":"assistant","time":{"created":1}},"parts":[
                        {"id":format!("p{n}a"),"type":"text","text":text("step")},
                        {"id":format!("p{n}b"),"type":"tool","tool":tool,"callID":format!("call{n}"),"state":{"status":"completed","input":input,"output":output(n, salt)}}
                    ]}),
                    vec![tagged(0), tagged(1)],
                )
            }
        }
        Profile::Broca => match n % 4 {
            0 => (
                json!({"role":"user","content":[{"type":"text","text":text("user")}]}),
                vec![tagged(0)],
            ),
            1 => (
                json!({"role":"assistant","content":[{"type":"text","text":text("step")},{"type":"tool_call","tool_call_id":call,"tool_name":tool,"input":input}]}),
                vec![tagged(0), untagged(1)],
            ),
            2 => (
                json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":call,"output":{"kind":"text","text":output(n, salt)},"is_error":false}]}),
                vec![tagged(0)],
            ),
            _ => (
                json!({"role":"assistant","content":[{"type":"text","text":text("answer")}]}),
                vec![tagged(0)],
            ),
        },
        Profile::Pi => {
            let body = match n % 4 {
                0 => json!({"role":"user","content":[{"type":"text","text":text("user")}]}),
                1 => {
                    json!({"role":"assistant","content":[{"type":"text","text":text("step")},{"type":"toolCall","id":call,"name":tool,"arguments":input}]})
                }
                2 => {
                    json!({"role":"toolResult","toolCallId":call,"toolName":tool,"content":[{"type":"text","text":output(n, salt)}],"isError":false})
                }
                _ => json!({"role":"assistant","content":[{"type":"text","text":text("answer")}]}),
            };
            let rows = if n % 4 == 1 {
                vec![tagged(0), untagged(1)]
            } else {
                vec![tagged(0)]
            };
            (
                json!({"type":"message","id":format!("m{n}"),"parentId":format!("m{}", n.saturating_sub(1)),"timestamp":"2026-05-01T16:52:33.700Z","message":body}),
                rows,
            )
        }
        Profile::Anthropic => match n % 4 {
            0 => (
                json!({"role":"user","content":text("user")}),
                vec![tagged(0)],
            ),
            1 => (
                json!({"role":"assistant","content":[
                    {"type":"thinking","thinking":format!("plan {n}"),"signature":format!("EqQBsig{n}+/==")},
                    {"type":"text","text":text("step")},
                    {"type":"tool_use","id":call,"name":tool,"input":input},
                ]}),
                vec![untagged(0), tagged(1), untagged(2)],
            ),
            2 => (
                json!({"role":"user","content":[{"type":"tool_result","tool_use_id":call,"content":output(n, salt)}]}),
                vec![tagged(0)],
            ),
            _ => (
                json!({"role":"assistant","content":[{"type":"text","text":text("answer")}]}),
                vec![tagged(0)],
            ),
        },
    };
    let mut entry = ReadMessage::new(n, format!("m{n}"), message).with_tags(rows);
    // A screenshot the person attached: read as a `media_ref`, never counted.
    if n.is_multiple_of(31) {
        let data = "iVBORw0KGgoAAAANSUhEUgAAB4AAAAQ4CAYAAADo08FD";
        let image = match profile {
            Profile::OpenCode => Some((
                "/parts",
                json!({"id":format!("p{n}i"),"type":"file","mime":"image/png","url":format!("data:image/png;base64,{data}")}),
            )),
            Profile::Pi if n.is_multiple_of(4) => Some((
                "/message/content",
                json!({"type":"image","data":data,"mimeType":"image/png"}),
            )),
            _ => None,
        };
        if let Some((parts, image)) = image {
            if let Some(parts) = entry
                .message
                .pointer_mut(parts)
                .and_then(Value::as_array_mut)
            {
                parts.push(image);
                entry.tags.push(untagged(entry.tags.len() as u64));
            }
        }
    }
    if profile == Profile::Pi && n % 16 == 1 {
        entry.message["message"]["content"][1]
            .as_object_mut()
            .unwrap()
            .remove("id");
    } else if profile == Profile::Pi && n % 16 == 2 {
        let call = self::message(profile, n - 1, salt);
        let decoded =
            crate::codec::pi::decode_pi_with_sidecar_and_ordinals(&[call.message], None, &[n]);
        let id = decoded.messages[0]
            .ck
            .content
            .iter()
            .find_map(|block| {
                if let ck_wire::CkKind::ToolCall { id, .. } = &block.kind {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .unwrap();
        entry.message["message"]["toolCallId"] = json!(id);
    }
    // Broca and OpenCode admit source system rows. Pi and Anthropic reject
    // that role at native provider ingress, so their fixtures retain native roles.
    if profile == Profile::Broca && n > 0 && n.is_multiple_of(48) {
        entry.message["role"] = json!("system");
    } else if profile == Profile::OpenCode && n > 0 && n.is_multiple_of(48) {
        entry.message = json!({"info":{"id":format!("m{n}"),"role":"system","time":{"created":1}},"parts":[{"id":format!("p{n}a"),"type":"text","text":format!("system source {n}.{salt}")}]});
        entry.tags = vec![tags::PartTag::untagged("0")];
    }
    entry.written_at = Some(1_000_000 + n * 7_000);
    entry
}

/// A tool result naming a call no earlier message made: a transcript the
/// engine refuses ("starts inside a tool arc") however often it is retried.
/// OpenCode carries a call and its result in one part, so it has none.
fn orphan(profile: Profile, n: u64) -> Option<ReadMessage> {
    let call = format!("ghost{n}");
    let message = match profile {
        Profile::OpenCode => return None,
        Profile::Broca => {
            json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":call,"output":{"kind":"text","text":output(n, 7)},"is_error":false}]})
        }
        Profile::Pi => {
            json!({"type":"message","id":format!("m{n}"),"parentId":format!("m{}", n.saturating_sub(1)),"timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"toolResult","toolCallId":call,"toolName":"read","content":[{"type":"text","text":output(n, 7)}],"isError":false}})
        }
        Profile::Anthropic => {
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":call,"content":output(n, 7)}]})
        }
    };
    Some(
        ReadMessage::new(n, format!("m{n}"), message)
            .with_tags(vec![tags::PartTag::tagged("0", tag(n, 0))]),
    )
}

/// The runner both providers read: one shared transcript and lineage.
#[derive(Default)]
struct Transcript {
    entries: Mutex<Vec<ReadMessage>>,
    lineage: Mutex<String>,
}

/// A reminder send without the members that depend on the clock: its
/// expiry, and the send id derived from it.
fn timeless(mut value: Value) -> Value {
    match &mut value {
        Value::Object(map) => {
            map.retain(|key, _| !key.contains("expires") && key != "send_id");
            for member in map.values_mut() {
                *member = timeless(member.take());
            }
        }
        Value::Array(items) => {
            for item in items {
                *item = timeless(item.take());
            }
        }
        _ => {}
    }
    value
}

/// A cancelled Tokio blocking task reports a process-local id. Preserve the
/// exact provider code and cancellation message, ignoring only that id.
fn comparable_answer(answer: String) -> String {
    let prefix = "Error { code: \"transient\", message: \"task ";
    let suffix = " was cancelled\" }";
    if let Some(id) = answer
        .strip_prefix(prefix)
        .and_then(|tail| tail.strip_suffix(suffix))
    {
        if !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()) {
            return format!("{prefix}<id>{suffix}");
        }
    }
    answer
}

#[test]
fn cancelled_blocking_tasks_differ_only_in_their_runtime_task_id() {
    let cancel_queued = || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        let (started, entered) = std::sync::mpsc::channel();
        let (release, blocked) = std::sync::mpsc::channel();
        let occupied = runtime.spawn_blocking(move || {
            started.send(()).unwrap();
            blocked.recv().unwrap();
        });
        entered.recv().unwrap();
        let queued = runtime.spawn_blocking(|| 4);
        queued.abort();
        runtime.shutdown_background();
        release.send(()).unwrap();
        let observer = tokio::runtime::Runtime::new().unwrap();
        observer.block_on(occupied).unwrap();
        let error = observer.block_on(queued).unwrap_err();
        assert!(error.is_cancelled());
        format!("{:?}", transient(error))
    };
    let first = cancel_queued();
    let second = cancel_queued();
    assert_ne!(first, second, "real runtime task identities must differ");
    assert_eq!(comparable_answer(first), comparable_answer(second));
    for answer in [
        "Error { code: \"fatal\", message: \"task 61 was cancelled\" }",
        "Error { code: \"transient\", message: \"task 61 panicked\" }",
        "Error { code: \"transient\", message: \"task -61 was cancelled\" }",
        "Error { code: \"transient\", message: \"task 61 was cancelled: partial work\" }",
    ] {
        assert_eq!(comparable_answer(answer.into()), answer);
    }
}

struct Runner {
    transcript: Arc<Transcript>,
    sends: Mutex<Vec<String>>,
    /// The same sends with their clock-dependent members, for rendering the
    /// reminder text a runner would deliver.
    raw_sends: Mutex<Vec<Value>>,
    /// The first ordinal of a lineage that begins at a cut: a read from
    /// below it is refused (`before_lineage_start`) and recorded.
    floor: Mutex<Option<u64>>,
    reads_below_floor: Mutex<Vec<u64>>,
    /// A `session.head` answer to give instead of the default (a lineage
    /// with no cut), for a test whose runner reports a lineage that begins
    /// at a cut.
    head: Mutex<Option<Value>>,
}

#[async_trait]
impl session_resolver::ProviderRunner for Runner {
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            route.parent_session(),
            method,
            params,
            budget,
        )
        .await
    }
    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "session.send" {
            self.raw_sends.lock().unwrap().push(params.clone());
            self.sends
                .lock()
                .unwrap()
                .push(timeless(params).to_string());
            return Ok(json!({"state":"pending","submission_id":"reminder"}));
        }
        if method == "role.describe" {
            return Ok(
                json!({"majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send"]}],"implementation_version":"fake","session_capabilities_from":"baseline","capabilities":["delivery_order"]}),
            );
        }
        if method == "session.head" {
            if let Some(head) = self.head.lock().unwrap().clone() {
                return Ok(head);
            }
            return Ok(json!({"first_ordinal":0}));
        }
        assert_eq!(method, "session.read");
        let lineage = self.transcript.lineage.lock().unwrap().clone();
        if params["lineage_id"]
            .as_str()
            .is_some_and(|held| held != lineage)
        {
            return Err(SessionResolveError::InvalidResponse(
                "lineage_changed".into(),
            ));
        }
        let from = params["from_ordinal"].as_u64().unwrap();
        if self.floor.lock().unwrap().is_some_and(|floor| from < floor) {
            self.reads_below_floor.lock().unwrap().push(from);
            return Err(SessionResolveError::InvalidResponse(
                "before_lineage_start".into(),
            ));
        }
        let mut entries = self.transcript.entries.lock().unwrap();
        renumber(&mut entries);
        let messages = entries
            .iter()
            .filter(|e| e.ordinal >= from)
            .take(9)
            .map(serve_descriptors)
            .collect::<Vec<_>>();
        let mut page = json!({"lineage_id":lineage,"messages":messages});
        if let Some(last) = messages
            .last()
            .filter(|last| entries.last().is_some_and(|end| end.ordinal > last.ordinal))
        {
            page["next_from_ordinal"] = json!(last.ordinal + 1);
        }
        Ok(page)
    }
}

struct Side {
    h: Arc<McHandler>,
    runner: Arc<Runner>,
    _bus: Arc<InMemoryBus>,
    task: tokio::task::JoinHandle<()>,
    db: PathBuf,
    _dir: tempfile::TempDir,
}

impl Drop for Side {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The session handle of the pair whose project folder is `project`. Each
/// pair has its own folder, and the session reference no longer depends on
/// the folder, so the session names the folder to keep each pair's reference,
/// and the test registries keyed by it, apart from concurrently running pairs.
fn pair_session(project: &Path) -> String {
    format!("s-{}", project.file_name().unwrap().to_string_lossy())
}

impl Side {
    async fn new(
        project: &Path,
        transcript: &Arc<Transcript>,
        oracle: bool,
        inject_docs: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("store.db");
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: db.to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let runner = Arc::new(Runner {
            transcript: Arc::clone(transcript),
            sends: Mutex::new(Vec::new()),
            raw_sends: Mutex::new(Vec::new()),
            floor: Mutex::new(None),
            reads_below_floor: Mutex::new(Vec::new()),
            head: Mutex::new(None),
        });
        let mut h = McHandler::new();
        h.store.set(store).ok().unwrap();
        h.provider_runner = runner.clone();
        let config = McModuleConfig {
            inject_docs,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            ..Default::default()
        };
        h.fixed_config = Some(config.clone());
        h.bind_route(
            7,
            SessionBinding {
                principal: Some(subc_protocol::Principal::Reserved {
                    module_id: "thalamus-harness".into(),
                }),
                scope: None,
                project_root: project.into(),
                harness: "runner".into(),
                session: pair_session(project),
                model_key: None,
                config,
                history_budget_tokens: 4_000.0,
            },
        );
        h.provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .oracle = oracle;
        let h = Arc::new(h);
        let bus = Arc::new(InMemoryBus::new(
            InMemoryConfig::default().with_durable(DurableOwner::Module(DEFAULT_MODULE_ID)),
        ));
        let task = h
            .clone()
            .start_compaction_bus(bus.clone(), "fixture".into())
            .await
            .unwrap();
        Self {
            h,
            runner,
            _bus: bus,
            task,
            db,
            _dir: dir,
        }
    }

    fn store(&self) -> &McStore {
        self.h.store.get().unwrap()
    }

    async fn dispatch(&self, request: Value) -> String {
        match self.h.dispatch_value(7, request).await {
            HandlerOutcome::Response(bytes) => String::from_utf8(bytes).unwrap(),
            other => format!("{other:?}"),
        }
    }

    /// Wait for the historian evaluations a step started.
    async fn settle(&self) {
        for _ in 0..2_000 {
            if self
                .h
                .provider_store
                .async_runtime
                .historian_inflight
                .load(std::sync::atomic::Ordering::SeqCst)
                == 0
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("historian evaluation did not finish");
    }

    /// Every stored view of the conversation and its version high-water.
    fn views(&self, reference: &str) -> (Vec<(u64, String)>, Option<i64>) {
        let conn = inspection_sql(&self.db);
        conn.busy_timeout(Duration::from_secs(30)).unwrap();
        let views = conn
            .prepare("SELECT version,view_json FROM mc_async_compaction_views WHERE session_ref=?1 ORDER BY version")
            .unwrap()
            .query_map([reference], |row| Ok((row.get::<_, i64>(0)? as u64, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let high = conn
            .query_row(
                "SELECT version_high_water FROM mc_async_compaction WHERE session_ref=?1",
                [reference],
                |row| row.get(0),
            )
            .ok();
        (views, high)
    }

    /// The record's decisions: sequence, completion, acknowledgement,
    /// generation, resync and lineage.
    fn decisions(&self, reference: &str) -> Option<String> {
        let state: State =
            serde_json::from_str(&self.store().load_async_compaction(reference).unwrap()?).unwrap();
        Some(format!(
            "seq={} completed={} applied={:?} generation={} resync={} lineage={:?} high={}",
            state.seq,
            state.completed_seq,
            state.applied,
            state.generation,
            state.resync,
            state.lineage,
            state.engine.version_high_water
        ))
    }
}

type Answer<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + 'a>>;

struct Pair {
    observe_delivered_acks: bool,
    last_delivered_ack: Option<(u64, String, u64, String)>,
    profile: Profile,
    transcript: Arc<Transcript>,
    resident: Side,
    oracle: Side,
    reference: String,
    seq: u64,
    model: String,
    log: Vec<String>,
    /// Only cuts the fake host actually applied, in active-branch order.
    /// Merely publishing a view does not make its marker survive a rewind.
    cut_checkpoints: Vec<u64>,
    cut_checkpoint_lineages: BTreeMap<u64, String>,
    /// Where the two providers' engine cache states first differed (a
    /// skipped engine pass leaves its writes out), for a failure message.
    /// It is a diagnostic, not part of the comparison.
    engine_drift: Option<String>,
    /// Record answer mismatches in `mismatches` instead of failing: only for
    /// the diagnostic replay of a diverging seed, never for the comparison.
    record_only: bool,
    mismatches: Vec<String>,
    immutable_views: std::cell::RefCell<BTreeMap<(bool, u64), String>>,
    /// Independent served-edit and reminder-echo observations; see
    /// `stack24_cache_review::Review`.
    review: std::cell::RefCell<stack24_cache_review::Review>,
    /// Engine state fields that differed between the two sides, by field,
    /// with the first difference; see `cut_lineage_tests`.
    engine_mismatches: std::cell::RefCell<BTreeMap<String, String>>,
    _project: tempfile::TempDir,
}

impl Pair {
    async fn new(profile: Profile, tiny_budget: bool) -> Self {
        Self::open(profile, tiny_budget, Some("L"), false).await
    }

    /// A pair whose Setup names `setup_lineage` (none when the runner has no
    /// lineage yet) and, with `inject_docs`, renders the project's docs.
    async fn open(
        profile: Profile,
        tiny_budget: bool,
        setup_lineage: Option<&str>,
        inject_docs: bool,
    ) -> Self {
        Self::open_with(profile, tiny_budget, setup_lineage, inject_docs, true).await
    }

    /// `open`, with the second side the full-recompute oracle or, when
    /// `oracle` is false, a second resident provider.
    async fn open_with(
        profile: Profile,
        tiny_budget: bool,
        setup_lineage: Option<&str>,
        inject_docs: bool,
        oracle: bool,
    ) -> Self {
        let project = tempfile::tempdir().unwrap();
        let transcript = Arc::new(Transcript {
            lineage: Mutex::new("L".into()),
            ..Default::default()
        });
        if inject_docs {
            std::fs::write(
                project.path().join("AGENTS.md"),
                "# Project rules\n\nKeep changes small and run the tests.\n",
            )
            .unwrap();
        }
        let resident = Side::new(project.path(), &transcript, false, inject_docs).await;
        let oracle = Side::new(project.path(), &transcript, oracle, inject_docs).await;
        if tiny_budget {
            resident
                .h
                .provider_store
                .async_runtime
                .resident
                .lock()
                .unwrap()
                .set_budget(4_096);
        }
        let session = pair_session(project.path());
        let reference = runner_session_ref("thalamus-harness", profile.harness(), &session);
        let mut pair = Self {
            observe_delivered_acks: false,
            last_delivered_ack: None,
            profile,
            transcript,
            resident,
            oracle,
            reference,
            seq: 0,
            model: "fixture".into(),
            log: Vec::new(),
            cut_checkpoints: Vec::new(),
            cut_checkpoint_lineages: BTreeMap::new(),
            engine_drift: None,
            record_only: false,
            mismatches: Vec::new(),
            immutable_views: Default::default(),
            review: Default::default(),
            engine_mismatches: Default::default(),
            _project: project,
        };
        let mut setup = json!({"method":"compaction.setup","params":{"session":session,"harness":profile.harness(),"request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":profile.wire()},"now":1}});
        if let Some(lineage) = setup_lineage {
            setup["params"]["lineage_id"] = json!(lineage);
        }
        pair.both("setup", |side| Box::pin(side.dispatch(setup.clone())))
            .await;
        pair
    }

    fn append(&self, count: u64) {
        self.append_salted(count, 0);
    }

    /// Append messages whose bytes differ from any earlier message at the
    /// same ordinals (after a revert or descent cut the transcript).
    fn append_salted(&self, count: u64, salt: u64) {
        let mut entries = self.transcript.entries.lock().unwrap();
        let next = entries.last().map_or(0, |entry| entry.ordinal + 1);
        let mut review = self.review.borrow_mut();
        for n in next..next + count {
            let mut entry = review
                .message(self.profile, n, salt)
                .unwrap_or_else(|| message(self.profile, n, salt));
            if self.profile == Profile::Pi {
                if let Some(parent) = entries.last() {
                    entry.message["parentId"] = json!(parent.mid);
                }
            }
            entries.push(entry);
        }
    }

    /// Run `op` on both sides, require identical answers and stores, and
    /// return the answer.
    async fn both<F>(&mut self, label: &str, op: F) -> String
    where
        F: for<'a> Fn(&'a Side) -> Answer<'a>,
    {
        if std::env::var_os("MC_REVIEW_TRACE").is_some() {
            eprintln!("review trace: running {label} after {:?}", self.log.last());
        }
        let timer = Instant::now();
        let resident = comparable_answer(op(&self.resident).await);
        let resident_ms = timer.elapsed().as_millis();
        self.resident.settle().await;
        let timer = Instant::now();
        let oracle = comparable_answer(op(&self.oracle).await);
        let oracle_ms = timer.elapsed().as_millis();
        self.oracle.settle().await;
        // Rides answer nothing once their deadline passes, so a slow side can
        // differ from a fast one for timing alone; report slow operations.
        if std::env::var_os("MC_REVIEW_TIMING").is_some() && resident_ms.max(oracle_ms) >= 500 {
            eprintln!(
                "review timing: {label} resident={resident_ms}ms oracle={oracle_ms}ms after {} steps",
                self.log.len()
            );
        }
        self.log.push(label.to_owned());
        if self.engine_drift.is_none() {
            self.engine_drift = self.engine_state_drift();
        }
        if self.record_only {
            self.mismatches.push(format!(
                "step {} {label}: resident {} | oracle {}",
                self.log.len(),
                resident.chars().take(160).collect::<String>(),
                oracle.chars().take(160).collect::<String>()
            ));
            return resident;
        }
        if resident != oracle && std::env::var_os("MC_CUT_DIFF_DETAIL").is_some() {
            let left = serde_json::from_str::<Value>(&resident).ok();
            let right = serde_json::from_str::<Value>(&oracle).ok();
            if let (Some(left), Some(right)) = (left, right) {
                eprintln!(
                    "ANSWER DIFF first={}",
                    cut_lineage_tests::first_difference(&left, &right, String::new())
                );
                if let (Ok(a), Ok(b)) = (
                    serde_json::from_value::<view::CompactionView>(left["view"].clone()),
                    serde_json::from_value::<view::CompactionView>(right["view"].clone()),
                ) {
                    eprintln!("ANSWER VIEW DIFF model_equal={} ranges_equal={} cut_left={:?} cut_right={:?} digest_left={} digest_right={}", self.model_bytes(&a)==self.model_bytes(&b), a.ranges==b.ranges, a.cut,b.cut,a.digest,b.digest);
                }
            }
        }
        assert_eq!(
            resident,
            oracle,
            "{:?} answer diverged at step {} ({label}); engine state drift: {:?}; steps: {:?}",
            self.profile,
            self.log.len(),
            self.engine_drift,
            self.log
        );
        self.compare(label);
        self.review.borrow_mut().collect_sends(
            &self.oracle.runner.raw_sends.lock().unwrap(),
            &self.transcript.entries.lock().unwrap(),
        );
        resident
    }

    /// The engine cache-state fields (meta members, frozen unit keys) that
    /// differ between the two providers now, with the step, if any do.
    fn engine_state_drift(&self) -> Option<String> {
        let side = |side: &Side| {
            let head = load_head(side.store(), &self.reference).ok()??;
            let loaded = side.store().load(&head.namespace()).ok()?;
            let mut meta = serde_json::to_value(&loaded.meta).ok()?;
            meta["frozen_unit_keys"] = json!(loaded
                .core
                .frozen_units
                .iter()
                .map(|unit| unit.key.clone())
                .collect::<Vec<_>>());
            meta["boundary_id"] = json!(loaded.core.boundary_id);
            // Clock readings differ between the two runs by construction.
            if let Some(baseline) = meta.get_mut("tail_hygiene_baseline") {
                if let Some(baseline) = baseline.as_object_mut() {
                    baseline.remove("computed_at_ms");
                }
            }
            if let Some(decisions) = meta
                .pointer_mut("/historian/recent_decisions")
                .and_then(Value::as_array_mut)
            {
                for decision in decisions {
                    if let Some(fields) = decision.as_object_mut() {
                        // These two fields record this provider's wall-clock
                        // observation time, not a historian decision or extent.
                        fields.remove("at_ms");
                        fields.remove("request_observed_at_ms");
                    }
                }
            }
            if let Value::Object(fields) = &mut meta {
                fields.retain(|key, _| !key.ends_with("_at_ms") && key != "expiry_cutoff_ms");
            }
            Some(meta)
        };
        let (Some(Value::Object(resident)), Some(Value::Object(oracle))) =
            (side(&self.resident), side(&self.oracle))
        else {
            return None;
        };
        let differing = resident
            .keys()
            .chain(oracle.keys())
            .filter(|key| resident.get(*key) != oracle.get(*key))
            .cloned()
            .collect::<BTreeSet<_>>();
        (!differing.is_empty()).then(|| {
            format!(
                "after step {} ({}): {:?}; historian full={:?} resident={:?}",
                self.log.len(),
                self.log.last().map_or("", String::as_str),
                differing,
                oracle.get("historian"),
                resident.get("historian")
            )
        })
    }

    fn compare(&self, label: &str) {
        let (resident, resident_high) = self.resident.views(&self.reference);
        let (oracle, oracle_high) = self.oracle.views(&self.reference);
        assert_eq!(
            resident.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            oracle.iter().map(|(v, _)| *v).collect::<Vec<_>>(),
            "{:?} view versions diverged after {label}; steps: {:?}",
            self.profile,
            self.log
        );
        for ((version, left), (_, right)) in resident.iter().zip(&oracle) {
            let left_view: view::CompactionView = serde_json::from_str(left).unwrap();
            if !self
                .immutable_views
                .borrow()
                .contains_key(&(false, *version))
            {
                let head = load_head(self.resident.store(), &self.reference).unwrap();
                let generation = head.as_ref().map_or(0, |head| head.generation);
                // Coverage is the publication's own snapshot. A later summary
                // may have a different boundary by the time a view is observed.
                let coverage = self
                    .resident
                    .store()
                    .load_async_compaction_views(&self.reference)
                    .unwrap()
                    .0
                    .into_iter()
                    .find(|(published, _, _, _)| published == version)
                    .and_then(|(_, _, engine, _)| engine)
                    .map(|engine| {
                        serde_json::from_str::<Value>(&engine).unwrap()["history_through"].as_u64()
                    })
                    .expect("each new view records its publication coverage");
                // Assemble before locking the transcript: assembly locks it too.
                let model = String::from_utf8(self.model_bytes(&left_view)).unwrap();
                self.review.borrow_mut().record_view(
                    self.profile,
                    *version,
                    &left_view,
                    &self.transcript.entries.lock().unwrap(),
                    &self.log,
                    coverage,
                    generation,
                    &model,
                );
            }
            let right_view: view::CompactionView = serde_json::from_str(right).unwrap();
            let left_model: Vec<Value> =
                serde_json::from_slice(&self.model_bytes(&left_view)).unwrap();
            let right_model: Vec<Value> =
                serde_json::from_slice(&self.model_bytes(&right_view)).unwrap();
            if left_model != right_model {
                let first = left_model
                    .iter()
                    .zip(&right_model)
                    .position(|(a, b)| a != b)
                    .unwrap_or(left_model.len().min(right_model.len()));
                panic!("{:?} served bytes after {label}, first={first}, left={:?}, right={:?}, steps={:?}, first_drift={:?}, drift={:?}, hygiene={:?}",
                    self.profile, left_model.get(first), right_model.get(first), self.log, self.engine_drift, self.engine_state_drift(), self.hygiene_state());
            }
            for (oracle, bytes) in [(false, left), (true, right)] {
                if let Some(previous) = self
                    .immutable_views
                    .borrow_mut()
                    .insert((oracle, *version), bytes.clone())
                {
                    assert_eq!(
                        previous, *bytes,
                        "view.get version {version} changed after {label}"
                    );
                }
            }
            assert!(
                left == right,
                "{:?} view {version} bytes diverged after {label}; native model bytes equal; first difference {}; steps: {:?}",
                self.profile,
                cut_lineage_tests::first_difference(&serde_json::from_str(left).unwrap(), &serde_json::from_str(right).unwrap(), String::new()),
                self.log
            );
        }
        assert_eq!(resident_high, oracle_high, "{label}: version high-water");
        let pending = |side: &Side| {
            let head = load_head(side.store(), &self.reference).unwrap().unwrap();
            let mut targets = side
                .store()
                .load_pending_agent_drops(&head.namespace())
                .unwrap()
                .into_iter()
                .map(|drop| drop.target_id)
                .collect::<Vec<_>>();
            targets.sort();
            targets
        };
        assert_eq!(
            pending(&self.resident),
            pending(&self.oracle),
            "{:?} pending target identities diverged after {label}; steps={:?}; state={:?}",
            self.profile,
            self.log,
            self.hygiene_state()
        );
        assert_eq!(
            self.resident.decisions(&self.reference),
            self.oracle.decisions(&self.reference),
            "{:?} record decisions diverged after {label}; steps: {:?}",
            self.profile,
            self.log
        );
        assert_eq!(
            *self.resident.runner.sends.lock().unwrap(),
            *self.oracle.runner.sends.lock().unwrap(),
            "{:?} reminder sends diverged after {label}; steps: {:?}",
            self.profile,
            self.log
        );
    }

    fn hygiene_state(&self) -> (Value, Value) {
        let side = |side: &Side| {
            let head = load_head(side.store(), &self.reference).unwrap().unwrap();
            let loaded = side.store().load(&head.namespace()).unwrap();
            let meta = serde_json::to_value(&loaded.meta).unwrap();
            let mut baseline = meta["tail_hygiene_baseline"].clone();
            if let Some(fields) = baseline.as_object_mut() {
                fields.remove("parts");
                fields.remove("baseline_parts");
                fields.remove("content_signature");
            }
            json!({"baseline":baseline,"coverage":meta["coverage_ordinal"],
                "generation":head.generation,"prefix_from":head.logical_prefix.as_ref().map(|p|p.tail_from),
                "reductions":loaded.core.frozen_units.iter().filter(|u|u.key.starts_with("red:")).map(|u|&u.key).collect::<Vec<_>>(),
                "last_level":meta["channel1_last_fire_level"],"last_ordinal":meta["channel1_last_fire_ordinal"],
                "channel1_units":loaded.core.frozen_units.iter().filter(|u|u.kind == "channel1_append").map(|u|&u.key).collect::<Vec<_>>()})
        };
        (side(&self.resident), side(&self.oracle))
    }

    /// Assemble the runner's native source rows and addressed edits, independently
    /// of engine input selection. Keep ranges read the original transcript, not
    /// the optimized engine's retained suffix or its output message metadata.
    fn model_bytes(&self, view: &view::CompactionView) -> Vec<u8> {
        let entries = self.transcript.entries.lock().unwrap();
        let mut assembled = Vec::new();
        let source = |entry: &ReadMessage, edits: &[view::PartEdit]| {
            let mut message = entry.message.clone();
            let before = parts(&message).unwrap();
            let mut after = Vec::new();
            for (part, tag) in before.iter().zip(&entry.tags) {
                let edit = edits.iter().find(|edit| {
                    edit.ordinal == entry.ordinal && edit.mid == entry.mid && edit.part == tag.part
                });
                if let Some(edit) = edit {
                    if let Some(bytes) = &edit.bytes {
                        after.push(serde_json::from_str(bytes).unwrap());
                    }
                } else {
                    after.push(render_part(part, tag.tag.as_deref(), true));
                }
            }
            drop(before);
            if message.get("parts").is_some() {
                message["parts"] = json!(after);
            } else if message.get("message").is_some() {
                message["message"]["content"] = json!(after);
            } else {
                message["content"] = json!(after);
            }
            message
        };
        for range in &view.ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    assembled.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap());
                }
                view::ViewRange::Keep { from, to, edits } => {
                    assembled.extend(
                        entries
                            .iter()
                            .filter(|e| e.ordinal >= *from && e.ordinal < *to)
                            .map(|entry| source(entry, edits)),
                    );
                }
                _ => panic!("unrecognized runner range"),
            }
        }
        assembled.extend(
            entries
                .iter()
                .filter(|e| e.ordinal > view.covers_through.ordinal)
                .map(|entry| source(entry, &[])),
        );
        // Pi's journal envelope is storage metadata, not a model message.
        if self.profile == Profile::Pi {
            for message in &mut assembled {
                if let Some(body) = message.get("message") {
                    *message = body.clone();
                }
            }
        }
        serde_json::to_vec(&assembled).unwrap()
    }

    fn newest_versions(&self) -> Vec<u64> {
        self.oracle
            .views(&self.reference)
            .0
            .into_iter()
            .map(|(version, _)| version)
            .collect()
    }

    async fn notice(&mut self, rng: &mut Rng, descent: Option<String>) -> String {
        self.seq += 1;
        let message = self.notice_message(rng, descent);
        self.deliver(message).await
    }

    /// Deliver `message` to both providers straight, as the bus loop does.
    async fn deliver(&mut self, message: cortexkit_bus_trait::Message) -> String {
        if self.observe_delivered_acks {
            let notice = notice::AdvanceNotice::from_headers(&message.headers).unwrap();
            self.last_delivered_ack = notice.applied_view_version.map(|version| {
                let raw = self
                    .oracle
                    .store()
                    .load_async_compaction_view(&self.reference, version)
                    .unwrap()
                    .expect("the delivered acknowledgement names a known public view");
                let published: view::CompactionView = serde_json::from_str(&raw).unwrap();
                (
                    notice.seq,
                    notice.lineage_id.clone(),
                    version,
                    published.lineage_id,
                )
            });
        }
        let label = format!(
            "notice {} est={} model={}",
            message.headers["seq"],
            message.headers.get("est_tokens").map_or("", String::as_str),
            self.model
        );
        self.both(&label, |side| {
            let message = message.clone();
            Box::pin(async move {
                match side.h.advance_compaction("fixture", &message).await {
                    Ok(()) => "ok".to_owned(),
                    Err(error) => format!("{error:?}"),
                }
            })
        })
        .await
    }

    /// The next notice: random usage, model, acknowledgement and events.
    fn notice_message(
        &mut self,
        rng: &mut Rng,
        descent: Option<String>,
    ) -> cortexkit_bus_trait::Message {
        let seq = self.seq;
        let (last_ordinal, digest) = {
            let entries = self.transcript.entries.lock().unwrap();
            let last = entries.last().unwrap();
            (
                last.ordinal,
                contract::digest::content_digest(&last.message),
            )
        };
        let est = match rng.below(10) {
            0 => 72_000,
            1 => 87_000,
            2 => 96_000,
            _ => 1_000 + rng.below(20_000),
        };
        if rng.chance(6) {
            self.model = if self.model == "fixture" {
                "fixture-2".into()
            } else {
                "fixture".into()
            };
        }
        let lineage = self.transcript.lineage.lock().unwrap().clone();
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            lineage.clone(),
            last_ordinal,
            digest,
            est,
            self.model.clone(),
        )
        .with_window(100_000);
        let versions = self.newest_versions();
        let mut events = Vec::new();
        let mut acknowledged = None;
        if !versions.is_empty() && rng.chance(70) {
            let version = if rng.chance(70) {
                *versions.last().unwrap()
            } else {
                versions[rng.below(versions.len() as u64) as usize]
            };
            notice = notice.with_applied_view_version(version);
            acknowledged = Some(version);
            match rng.below(8) {
                0 => events.push(notice::Event::ViewCompanion {
                    view_version: version,
                    edit: "strip_signed_reasoning".into(),
                }),
                1 => events.push(notice::Event::ViewDeferred {
                    view_version: version,
                    reason: "mid_turn".into(),
                }),
                2 => events.push(notice::Event::MarkerOutcome {
                    outcome: notice::MarkerOutcome::Applied,
                    cut_id: format!("v{version}"),
                }),
                _ => {}
            }
        }
        if let Some(version) = versions.last().filter(|_| rng.chance(5)) {
            events.push(notice::Event::ViewRefused {
                view_version: *version,
                reason: "structural".into(),
            });
        }
        // A version the same notice defers or refuses was not served.
        if let Some(version) = acknowledged.filter(|version| {
            !events.iter().any(|event| {
                matches!(event, notice::Event::ViewDeferred { view_version, .. }
                    | notice::Event::ViewRefused { view_version, .. } if view_version == version)
            })
        }) {
            self.review
                .borrow_mut()
                .acknowledge(self.log.len(), version);
        }
        if !events.is_empty() {
            notice = notice.with_events(events);
        }
        let mut headers = notice.to_headers();
        headers.insert("lineage_id".into(), lineage);
        if let Some(descent) = descent {
            headers.insert("descends_from".into(), descent);
        }
        let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
        cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
            id: bus_id(&self.reference, "advanced", seq),
            digest: notice.digest().parse().unwrap(),
            headers,
        }
    }

    fn tags(&self) -> Vec<u64> {
        let entries = self.transcript.entries.lock().unwrap();
        entries
            .iter()
            .flat_map(|entry| entry.tags.iter().filter_map(|row| row.tag.as_deref()))
            .filter_map(tags::parse_tag)
            .collect()
    }

    async fn step(&mut self, rng: &mut Rng) {
        let roll = rng.below(100);
        self.step_roll(rng, roll).await;
    }

    /// One randomized step of kind `roll` (0 to 99).
    async fn step_roll(&mut self, rng: &mut Rng, roll: u64) {
        match roll {
            0..=44 => {
                let count = 1 + rng.below(5);
                self.append(count);
                self.notice(rng, None).await;
            }
            45..=52 => {
                let known = self.tags();
                let mut drop = (0..1 + rng.below(3))
                    .filter_map(|_| known.get(rng.below(known.len() as u64) as usize))
                    .map(u64::to_string)
                    .collect::<Vec<_>>();
                if rng.chance(20) {
                    drop.push("999999".into());
                }
                let request = json!({"name":"ctx_reduce","arguments":{"drop":drop.join(",")}});
                if std::env::var_os("MC_REVIEW_TRACE").is_some() {
                    eprintln!("review trace: ctx_reduce drop={}", drop.join(","));
                }
                self.review
                    .borrow_mut()
                    .requested
                    .extend(drop.iter().filter_map(|tag| tag.parse::<u64>().ok()));
                self.both("ctx_reduce", |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            }
            53..=60 => {
                let last = self
                    .transcript
                    .entries
                    .lock()
                    .unwrap()
                    .last()
                    .map_or(0, |entry| entry.ordinal);
                let end = last / 2 + rng.below(last / 2 + 1) / 2;
                let reference = self.reference.clone();
                self.both("historian publish", |side| {
                    let reference = reference.clone();
                    Box::pin(async move { publish_history(side, &reference, end) })
                })
                .await;
                self.append(1 + rng.below(3));
                self.notice(rng, None).await;
            }
            61..=65 => {
                let reference = self.reference.clone();
                self.both("ctx-flush", |side| {
                    let reference = reference.clone();
                    Box::pin(async move {
                        let store = side.store();
                        let Some(head) = load_head(store, &reference).unwrap() else {
                            return "no conversation".into();
                        };
                        store.arm_soft_refresh(&head.namespace()).unwrap();
                        format!("{:?}", side.h.publish_async_wake(&reference).await)
                    })
                })
                .await;
            }
            66..=75 => {
                let (cause, overflow) = match rng.below(6) {
                    0 => ("ttl_expired", None),
                    1 => ("model_change", None),
                    2 => ("surface_change", None),
                    3 => ("ceiling", None),
                    4 => (
                        "ceiling",
                        Some(json!({"reported_limit_tokens":60_000 + rng.below(30_000)})),
                    ),
                    _ => ("ceiling", Some(json!({}))),
                };
                let mut params = json!({"session_ref":self.reference,"cause":cause,"deadline_ms":if cause == "ceiling" { 60_000 } else { 10_000 }});
                if let Some(overflow) = overflow {
                    params["overflow"] = overflow;
                }
                if rng.chance(50) {
                    self.append(1 + rng.below(2));
                }
                let request = json!({"method":"compaction.ride","params":params});
                self.both(&format!("ride {cause}"), |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            }
            76..=79 => {
                // The runner rewrote its newest message: a digest mismatch.
                {
                    let mut entries = self.transcript.entries.lock().unwrap();
                    if let Some(last) = entries.last_mut() {
                        *last = message(self.profile, last.ordinal, 1 + rng.below(1_000));
                    }
                }
                self.notice(rng, None).await;
            }
            80..=83 => {
                // Restore under a new lineage: the same messages, re-read.
                *self.transcript.lineage.lock().unwrap() = format!("L{}", self.seq);
                self.append(rng.below(2));
                self.notice(rng, None).await;
            }
            84..=87 => {
                // A fork: the runner cuts the transcript after an earlier
                // message, continues under a new lineage and names the cut
                // (`descends_from`) so the provider keeps what precedes it.
                let (parent, through, digest) = {
                    let mut entries = self.transcript.entries.lock().unwrap();
                    let len = entries.len() as u64;
                    let through = len / 2 + rng.below(len / 2);
                    entries.truncate(through as usize + 1);
                    let digest =
                        contract::digest::content_digest(&entries[through as usize].message);
                    (
                        self.transcript.lineage.lock().unwrap().clone(),
                        through,
                        digest,
                    )
                };
                *self.transcript.lineage.lock().unwrap() = format!("F{}", self.seq);
                self.append_salted(1 + rng.below(4), 5_000 + self.seq);
                self.notice(rng, Some(format!("{parent}:{through}:{digest}")))
                    .await;
            }
            88..=90 => {
                // A revert without a new lineage: the transcript shortened.
                {
                    let mut entries = self.transcript.entries.lock().unwrap();
                    let keep = entries.len() * 3 / 4;
                    entries.truncate(keep.max(4));
                }
                self.append_salted(1 + rng.below(3), 9_000 + self.seq);
                self.notice(rng, None).await;
            }
            91..=92 if self.profile != Profile::OpenCode => {
                // A transcript the engine refuses: the conversation fails
                // after a bounded number of attempts on both sides.
                {
                    let mut entries = self.transcript.entries.lock().unwrap();
                    let next = entries.last().map_or(0, |entry| entry.ordinal + 1);
                    entries.extend(orphan(self.profile, next));
                }
                for _ in 0..MAX_PROTOCOL_ATTEMPTS {
                    self.notice(rng, None).await;
                }
            }
            91..=95 => {
                // A provider process restart: the resident copy is gone and
                // the next operation rebuilds the conversation from rows.
                self.resident
                    .h
                    .provider_store
                    .async_runtime
                    .resident
                    .lock()
                    .unwrap()
                    .forget(&self.reference);
                self.log.push("restart".into());
            }
            _ => {
                let versions = self.newest_versions();
                let version = versions
                    .get(rng.below(versions.len() as u64 + 1) as usize)
                    .copied()
                    .unwrap_or(9_999);
                let request = json!({"method":"view.get","params":{"session_ref":self.reference,"view_version":version}});
                self.both("view.get", |side| Box::pin(side.dispatch(request.clone())))
                    .await;
            }
        }
    }
}

async fn session(profile: Profile, seed: u64, steps: u64) -> usize {
    session_pair(profile, seed, steps)
        .await
        .newest_versions()
        .len()
}

async fn session_pair(profile: Profile, seed: u64, steps: u64) -> Pair {
    session_pair_with(profile, seed, steps, false).await
}

/// `session_pair`, optionally with the runner echoing accepted reminder sends
/// into the transcript (see `stack24_cache_review::Review::message`).
async fn session_pair_with(profile: Profile, seed: u64, steps: u64, echoes: bool) -> Pair {
    let (mut pair, mut rng) = session_start(profile, seed, echoes).await;
    for _ in 0..steps {
        pair.step(&mut rng).await;
    }
    pair
}

/// A seeded session through its first notice, with the generator positioned
/// for its first random step.
async fn session_start(profile: Profile, seed: u64, echoes: bool) -> (Pair, Rng) {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    // A runner with no lineage yet sends Setup without one.
    let setup_lineage = (!rng.chance(25)).then_some("L");
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open(profile, tiny_budget, setup_lineage, inject_docs).await;
    pair.review.borrow_mut().echoes = echoes;
    let mostly_covered = rng.chance(50);
    pair.append(if mostly_covered {
        192 + rng.below(40)
    } else {
        16 + rng.below(40)
    });
    if mostly_covered {
        let end = pair.transcript.entries.lock().unwrap().len() as u64 - 12;
        let reference = pair.reference.clone();
        pair.both("initial mostly-covered history", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, end) })
        })
        .await;
    }
    pair.notice(&mut rng, None).await;
    (pair, rng)
}

async fn run(sessions: u64, steps: u64, first_seed: u64) {
    let mut published = 0;
    for index in 0..sessions {
        let profile = PROFILES[(index % 4) as usize];
        published += session(profile, first_seed + index, steps).await;
    }
    eprintln!(
        "differential: {sessions} sessions, {steps} steps each, {published} views retained at the end; the resident side skipped {} engine passes",
        resident::counters::skipped_engine_passes()
    );
}

/// Two sessions per schema in the default suite.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resident_matches_the_full_recompute_oracle() {
    run(8, 14, 1).await;
}

#[tokio::test]
async fn first_certified_view_matches_full_lineage_render() {
    // The resident side renders the first certified view from the view's own
    // sources; the oracle renders it from the whole lineage. `both` requires
    // the published bytes, ranges and edits to be identical.
    for profile in PROFILES {
        let mut pair = Pair::new(profile, false).await;
        pair.append(200);
        let reference = pair.reference.clone();
        pair.both("covered history before the first notice", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, 187) })
        })
        .await;
        let mut rng = Rng(17);
        let outcome = pair.notice(&mut rng, None).await;
        assert_eq!(outcome, "ok", "{profile:?}: {outcome}");
        let head = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(
            head.logical_prefix.is_some(),
            "{profile:?}: the first pass did not certify; log={:?}",
            pair.log
        );
        assert!(
            !pair.newest_versions().is_empty(),
            "{profile:?}: no view published"
        );
    }
}

#[tokio::test]
async fn prefix_matches_full_lineage_with_crossing_native_arcs() {
    for profile in PROFILES {
        let mut pair = Pair::new(profile, false).await;
        pair.append(160);
        let reference = pair.reference.clone();
        pair.both("covered prefix with crossing arc", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, 149) })
        })
        .await;
        let mut rng = Rng(91);
        let outcome = pair.notice(&mut rng, None).await;
        assert_eq!(outcome, "ok", "{profile:?}: {outcome}");
        let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"ceiling","deadline_ms":300_000}});
        pair.both("crossing arc ride", |side| {
            Box::pin(side.dispatch(request.clone()))
        })
        .await;
        let head = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert!(
            head.logical_prefix.is_some(),
            "{profile:?}: no certificate; failed={:?}, coverage={:?}, log={:?}",
            head.failure,
            pair.resident
                .store()
                .load(&head.namespace())
                .unwrap()
                .meta
                .coverage_ordinal,
            pair.log
        );
        if profile != Profile::OpenCode {
            assert_eq!(head.logical_prefix.as_ref().unwrap().tail_from, 149);
            let proof = serde_json::to_value(&head.logical_prefix).unwrap();
            assert_eq!(
                proof["crossing_arcs"],
                json!([[149, 150]]),
                "the certificate lost its cross-cut invocation/result ledger"
            );
        }
        if matches!(profile, Profile::Broca | Profile::OpenCode) {
            assert!(!head
                .logical_prefix
                .as_ref()
                .unwrap()
                .context_sources
                .is_empty());
        }
        pair.append(4);
        let reference = pair.reference.clone();
        pair.both("later coverage fold", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, 155) })
        })
        .await;
        pair.both("later native ride", |side| {
            Box::pin(side.dispatch(request.clone()))
        })
        .await;
    }
}

#[tokio::test]
async fn defer_preserves_prefix_certificate_and_served_model_bytes() {
    let mut pair = Pair::new(Profile::Broca, false).await;
    pair.append(160);
    let reference = pair.reference.clone();
    pair.both("mostly covered prefix", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, 147) })
    })
    .await;
    let mut rng = Rng(12);
    pair.notice(&mut rng, None).await;
    let ride = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"ceiling","deadline_ms":300_000}});
    pair.both("freeze prefix", |side| {
        Box::pin(side.dispatch(ride.clone()))
    })
    .await;
    let before = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let proof = serde_json::to_value(&before.logical_prefix).unwrap();
    assert!(!proof.is_null());
    pair.append(4);
    let reference = pair.reference.clone();
    pair.both("direct low-pressure defer", |side| {
        let reference = reference.clone();
        Box::pin(async move {
            let mut state = side.h.checkout(side.store(), &reference).unwrap().unwrap();
            let from = *state.entries.last_key_value().unwrap().0;
            side.h
                .read_async(&mut state, from, Duration::from_secs(10))
                .await
                .unwrap();
            let answer = side
                .h
                .publish_async(0, &mut state, codec::Codec::OwnedBroca, false)
                .unwrap();
            state.save(side.store(), &[]).unwrap();
            side.h.checkin(state);
            serde_json::to_string(&answer).unwrap()
        })
    })
    .await;
    let after = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(
        proof,
        serde_json::to_value(&after.logical_prefix).unwrap(),
        "Defer advanced the prefix certificate"
    );
    assert_eq!(
        before.produced_view.as_ref().map(|v| &v.json),
        after.produced_view.as_ref().map(|v| &v.json)
    );
}

#[tokio::test]
async fn covered_tool_result_drop_uses_prefix_membership_without_projecting_an_orphan() {
    let mut pair = Pair::new(Profile::Broca, false).await;
    pair.append(160);
    let reference = pair.reference.clone();
    pair.both("covered tool history", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, 147) })
    })
    .await;
    let mut rng = Rng(12);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    // The number the runner's read shows for message 6's first part.
    let number = {
        let mut entries = pair.transcript.entries.lock().unwrap();
        renumber(&mut entries);
        tags::parse_tag(entries[6].tags[0].tag.as_deref().unwrap()).unwrap()
    };
    let request = json!({"name":"ctx_reduce","arguments":{"drop":number.to_string()}});
    pair.both("covered result drop", |side| {
        Box::pin(side.dispatch(request.clone()))
    })
    .await;
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    let head = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(pair
        .resident
        .store()
        .load_pending_agent_drops(&head.namespace())
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn prefix_replays_channel1_session_1101() {
    session(Profile::OpenCode, 1101, 24).await;
}

#[tokio::test]
async fn prefix_replays_reduction_session_1181() {
    session(Profile::OpenCode, 1181, 24).await;
}

#[tokio::test]
async fn prefix_replays_reduction_session_1233() {
    session(Profile::OpenCode, 1233, 24).await;
}

#[tokio::test]
async fn async_conversations_deliver_ctx_reduce_only_out_of_band() {
    for profile in PROFILES {
        let pair = session_pair(profile, 1101, 24).await;
        for side in [&pair.resident, &pair.oracle] {
            let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
            let loaded = side.store().load(&head.namespace()).unwrap();
            assert!(
                !loaded
                    .core
                    .frozen_units
                    .iter()
                    .any(|unit| unit.kind == "channel1_append"),
                "{profile:?}: async engine created an in-band ctx_reduce reminder"
            );
            for (_, bytes) in side.views(&pair.reference).0 {
                assert!(
                    !bytes.contains("spent tool outputs") && !bytes.contains("Still unstamped:"),
                    "{profile:?}: published an in-band ctx_reduce reminder"
                );
            }
        }
        if profile == Profile::OpenCode {
            assert!(
                !pair.oracle.runner.sends.lock().unwrap().is_empty(),
                "the reminder must still be delivered through session.send"
            );
        }
    }
}

/// The full differential: `MC_ASYNC_DIFFERENTIAL_SESSIONS` sessions (default
/// 300) over all four schemas, run in parallel batches.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "long randomized differential; run explicitly with --ignored"]
async fn resident_matches_the_full_recompute_oracle_over_many_sessions() {
    let sessions = std::env::var("MC_ASYNC_DIFFERENTIAL_SESSIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(300u64);
    let steps = std::env::var("MC_ASYNC_DIFFERENTIAL_STEPS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(24u64);
    let first = std::env::var("MC_ASYNC_DIFFERENTIAL_FIRST_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1_000u64);
    // Every session runs to its end or its first divergence; all divergences
    // are listed together, so one does not hide the others.
    let mut failures = Vec::new();
    let mut tasks = Vec::new();
    let settle = |tasks: &mut Vec<(u64, Profile, tokio::task::JoinHandle<usize>)>| {
        let drained = std::mem::take(tasks);
        async move {
            let mut failed = Vec::new();
            for (seed, profile, task) in drained {
                if let Err(error) = task.await {
                    let message = error
                        .try_into_panic()
                        .ok()
                        .and_then(|panic| {
                            panic
                                .downcast_ref::<String>()
                                .cloned()
                                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                        })
                        .unwrap_or_default();
                    failed.push(format!(
                        "seed {seed} {profile:?}: {}",
                        message.chars().take(1_500).collect::<String>()
                    ));
                }
            }
            failed
        }
    };
    for index in 0..sessions {
        let profile = PROFILES[(index % 4) as usize];
        let seed = first + index;
        tasks.push((seed, profile, tokio::spawn(session(profile, seed, steps))));
        if tasks.len() == 8 {
            failures.extend(settle(&mut tasks).await);
        }
    }
    failures.extend(settle(&mut tasks).await);
    eprintln!(
        "differential: {sessions} sessions, {steps} steps each, {} diverged; the resident side skipped {} engine passes",
        failures.len(),
        resident::counters::skipped_engine_passes()
    );
    for failure in &failures {
        eprintln!("DIVERGENCE {failure}");
    }
    assert!(failures.is_empty(), "{} sessions diverged", failures.len());
}

/// A Setup without a lineage, then notices naming the runner's lineage: the
/// first lineage is adopted, not refused, and a view publishes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_without_a_lineage_adopts_the_first_one_and_publishes() {
    let mut rng = Rng(7);
    let mut pair = Pair::open(Profile::OpenCode, false, None, false).await;
    *pair.transcript.lineage.lock().unwrap() = "runner-lineage".into();
    pair.append(30);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    let reference = pair.reference.clone();
    pair.both("historian publish", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, 12) })
    })
    .await;
    pair.append(2);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    let (views, _) = pair.oracle.views(&pair.reference);
    let (_, newest) = views.last().expect("a view publishes");
    let view: view::CompactionView = serde_json::from_str(newest).unwrap();
    assert_eq!(view.lineage_id, "runner-lineage");
    assert_eq!(
        pair.oracle.decisions(&pair.reference).unwrap(),
        pair.resident.decisions(&pair.reference).unwrap()
    );
}

/// A lineage change without a fork descent is a resync (contract §5.2), not
/// an error: the provider re-reads the new lineage and publishes a view at a
/// higher version.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lineage_change_without_descent_resyncs_and_publishes() {
    let mut rng = Rng(11);
    let mut pair = Pair::new(Profile::Anthropic, false).await;
    pair.append(24);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    let before = pair.newest_versions().last().copied().unwrap_or(0);
    *pair.transcript.lineage.lock().unwrap() = "L-restored".into();
    pair.append(4);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    let (views, _) = pair.oracle.views(&pair.reference);
    let (version, newest) = views.last().expect("the resync publishes a view");
    assert!(
        *version > before,
        "the resync view is newer: {version} vs {before}"
    );
    let view: view::CompactionView = serde_json::from_str(newest).unwrap();
    assert_eq!(view.lineage_id, "L-restored");
}

/// A notice the engine refuses on protocol grounds is retried a bounded
/// number of times, then the conversation is in the named `failed` state:
/// readable in its record and in a ride's error, with later notices
/// acknowledged without work.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_protocol_error_fails_the_conversation_after_bounded_attempts() {
    let mut rng = Rng(13);
    let mut pair = Pair::new(Profile::Broca, false).await;
    pair.append(9);
    assert_eq!(pair.notice(&mut rng, None).await, "ok");
    {
        let mut entries = pair.transcript.entries.lock().unwrap();
        let next = entries.last().unwrap().ordinal + 1;
        entries.extend(orphan(Profile::Broca, next));
    }
    pair.seq += 1;
    let message = pair.notice_message(&mut rng, None);
    let mut answers = Vec::new();
    for _ in 0..MAX_PROTOCOL_ATTEMPTS {
        answers.push(pair.deliver(message.clone()).await);
    }
    assert!(
        answers[..answers.len() - 1]
            .iter()
            .all(|answer| answer.contains("transient") && answer.contains(PROTOCOL_ERROR)),
        "{answers:?}"
    );
    assert_eq!(
        answers.last().unwrap(),
        "ok",
        "the bound acknowledges the notice"
    );
    for side in [&pair.resident, &pair.oracle] {
        let state = load_head(side.store(), &pair.reference).unwrap().unwrap();
        let failure = state.failure.expect("a named failure state");
        assert_eq!(failure.state, FailureState::Failed);
        assert_eq!(failure.code, PROTOCOL_ERROR);
        assert_eq!(failure.attempts, MAX_PROTOCOL_ATTEMPTS);
        assert!(failure.reason.contains("tool arc"), "{}", failure.reason);
    }
    pair.append(1);
    assert_eq!(
        pair.notice(&mut rng, None).await,
        "ok",
        "a failed conversation acknowledges"
    );
    let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"ceiling","deadline_ms":10_000}});
    let ride = pair
        .both("ride", |side| Box::pin(side.dispatch(request.clone())))
        .await;
    assert!(ride.contains(FAILED_ERROR), "{ride}");
}

/// A finished historian summary through `end`, as a historian publication
/// leaves it: the compartment and an armed refresh.
fn publish_history(side: &Side, reference: &str, end: u64) -> String {
    let store = side.store();
    let Some(head) = load_head(store, reference).unwrap() else {
        return "no conversation".into();
    };
    let namespace = head.namespace();
    store
        .replace_compartments(
            &namespace,
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: end as i64,
                end_message_id: format!("m{end}#0"),
                title: "history".into(),
                content: format!("summary through {end}"),
                p1: Some(format!("summary through {end}")),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    store.arm_soft_refresh(&namespace).unwrap();
    "published".into()
}

/// Replay one diverging seed (`MC_ASYNC_DIFFERENTIAL_FIRST_SEED`, profile
/// from `MC_ASYNC_DIFFERENTIAL_PROFILE` index), printing both providers'
/// answer at every step and then pushing both through engine-running
/// notices, to see whether a divergence persists. Diagnostic only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "diagnostic replay of one differential seed"]
async fn replay_one_seed() {
    let seed = std::env::var("MC_ASYNC_DIFFERENTIAL_FIRST_SEED")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1_033u64);
    let profile = PROFILES[std::env::var("MC_ASYNC_DIFFERENTIAL_PROFILE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1)];
    let steps = 24;
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    let setup_lineage = (!rng.chance(25)).then_some("L");
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open(profile, tiny_budget, setup_lineage, inject_docs).await;
    pair.record_only = true;
    pair.append(16 + rng.below(40));
    pair.notice(&mut rng, None).await;
    for _ in 0..steps {
        pair.step(&mut rng).await;
    }
    // Retry the last notice as the bus would, then force engine passes.
    for _ in 0..3 {
        let message = pair.notice_message(&mut rng, None);
        pair.deliver(message).await;
    }
    for _ in 0..3 {
        pair.append(1);
        pair.seq += 1;
        let mut message = pair.notice_message(&mut rng, None);
        message.headers.insert("est_tokens".into(), "96000".into());
        let notice = notice::AdvanceNotice::from_headers(&message.headers).unwrap();
        message.digest = notice.digest().parse().unwrap();
        pair.deliver(message).await;
    }
    for line in &pair.mismatches {
        eprintln!("REPLAY {line}");
    }
}
