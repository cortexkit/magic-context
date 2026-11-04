//! Opt-in, process-CPU measurement of the complete in-process notice worker.
//! Run alone, in release mode; normal tests only smoke-check the fixture paths.

#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cortexkit_role_compaction::notice::{Conditions, NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::part::{PartBody, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, Select, SessionRef,
};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, View};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use mc_mock_runner::transcript::part;
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::module::Module;
use mc_module::pass::Settings;
use mc_module::route::Route;
use mc_module::routing::{RouteError, Router};
use mc_module::session::Session;
use mc_module::store::{Durable, Store};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

const WINDOW: u64 = 1_000_000;
const RESERVE: u64 = 128_000;
const HELD: usize = 210;
const TRIALS: usize = 200;
const WARM_STEPS: u64 = 3;

#[derive(Clone, Copy, Debug)]
enum Shape {
    Pi,
    OpenCode2,
}

impl Shape {
    fn harness(self) -> &'static str {
        match self {
            Self::Pi => "pi",
            Self::OpenCode2 => "opencode2",
        }
    }

    fn runner(self) -> &'static str {
        match self {
            Self::Pi => "thalamus-pi",
            Self::OpenCode2 => "thalamus-opencode2",
        }
    }
}

fn rules() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn model() -> ModelRef {
    ModelRef::new("anthropic", "claude-opus-4-6")
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

fn text(n: u64, slot: &str) -> cortexkit_role_compaction::part::Part {
    part(
        format!("p{n}-{slot}"),
        Some(n * 3 + u64::from(slot == "assistant")),
        Seal::None,
        PartBody::Text {
            text: format!(
                "Review component {n}: preserve the public API and existing cache boundaries. {}",
                "Check the focused tests before publishing the change. ".repeat(3)
            ),
        },
    )
}

fn entry(n: u64, role: Role, parts: Vec<cortexkit_role_compaction::part::Part>) -> Entry {
    Entry::new(n, format!("m{n}"), role, 1_000_000 + n, parts)
}

fn assistant(n: u64, output_bytes: u64) -> Entry {
    let mut tool = ToolPart::new(
        format!("call-{n}"),
        "read",
        json!({"path":format!("src/component-{n}.rs"),"reason":"Inspect the implementation and its focused tests before preparing a small compatible change. ".repeat(2)}),
        ToolStatus::Completed,
    );
    tool.output_bytes = Some(output_bytes);
    // Compact notices carry output sizes, never the potentially large body.
    let tool = part(
        format!("p{n}-tool"),
        Some(n * 3 + 2),
        Seal::None,
        PartBody::Tool(tool),
    );
    entry(n, Role::Assistant, vec![text(n, "assistant"), tool])
}

fn cycle(shape: Shape, n: u64, offset: usize) -> Entry {
    match offset % 3 {
        0 => entry(n, Role::User, vec![text(n, "user")]),
        1 => assistant(
            n,
            if (offset / 3).is_multiple_of(64) {
                20_480
            } else {
                2_048
            },
        ),
        _ => match shape {
            // Compaction contract W4.1: Pi toolResult rows have no parts;
            // their result is attached to the original call's tool part.
            Shape::Pi => entry(n, Role::User, vec![]),
            Shape::OpenCode2 => entry(n, Role::Assistant, vec![text(n, "assistant")]),
        },
    }
}

struct RunnerState {
    original: Arc<Vec<Entry>>,
    added: Vec<Entry>,
    view: View,
    offered: usize,
}

#[derive(Clone)]
struct Client(Arc<Mutex<RunnerState>>);

impl Client {
    fn newest(&self) -> Cursor {
        let state = self.0.lock().unwrap();
        cursor(
            state
                .added
                .last()
                .unwrap_or_else(|| state.original.last().unwrap()),
        )
    }

    fn applied(&self) -> cortexkit_role_compaction::view::AppliedView {
        self.0.lock().unwrap().view.applied()
    }

    fn step(&self, shape: Shape) -> Vec<Entry> {
        let mut state = self.0.lock().unwrap();
        let n = state.original.len() as u64 + state.added.len() as u64 + 1;
        let mut entries = vec![assistant(n, 2_048)];
        if matches!(shape, Shape::Pi) {
            entries.push(entry(n + 1, Role::User, vec![]));
        }
        state.added.extend(entries.clone());
        entries
    }
}

impl RunnerClient for Client {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let state = self.0.lock().unwrap();
        let at = |ordinal: usize| {
            if ordinal <= state.original.len() {
                state.original.get(ordinal.checked_sub(1)?)
            } else {
                state.added.get(ordinal - state.original.len() - 1)
            }
        };
        let (candidates, limit): (Vec<&Entry>, _) = match request.select {
            Select::After {
                after_ordinal,
                limit,
            } => (
                state
                    .original
                    .iter()
                    .chain(&state.added)
                    .skip(after_ordinal.unwrap_or(0) as usize)
                    .collect(),
                limit,
            ),
            Select::Mids { mids } => (
                mids.iter()
                    .filter_map(|mid| at(mid.strip_prefix('m')?.parse().ok()?))
                    .collect(),
                None,
            ),
            other => panic!("unexpected measurement read selector: {other:?}"),
        };
        let mut entries = Vec::new();
        let mut bytes = 0;
        let mut next_after = None;
        for entry in candidates {
            let size = serde_json::to_vec(entry).unwrap().len() as u64;
            if !entries.is_empty()
                && (request.max_bytes.is_some_and(|max| bytes + size > max)
                    || limit.is_some_and(|max| entries.len() >= max as usize))
            {
                next_after = entries.last().map(|e: &Entry| e.ordinal);
                break;
            }
            bytes += size;
            entries.push(entry.clone());
        }
        let mut head = Head::new();
        head.newest = Some(cursor(
            state
                .added
                .last()
                .unwrap_or_else(|| state.original.last().unwrap()),
        ));
        head.applied_view = Some(state.view.applied());
        let mut page = ReadPage::new(entries, head);
        page.next_after = next_after;
        Ok(page)
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        // A constant-time runner acknowledgement excludes runner rendering and
        // model execution from the provider's process-CPU measurement.
        let mut state = self.0.lock().unwrap();
        assert!(request.view.version > state.view.version);
        state.view = request.view;
        state.offered += 1;
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = Some(self.0.lock().unwrap().view.clone());
        Ok(answer)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        panic!("no reminder templates are admitted by the measurement runner")
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        panic!("the fixture's unsummarized history must fit inside the protected tail")
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!("no summary run was started")
    }
}

impl Router for Client {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        panic!("historian trigger unexpectedly admitted a run")
    }
    async fn report(&self, _: ReportRequest) {
        unreachable!("no summary run was started")
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    key: SessionRef,
    entries: Arc<Vec<Entry>>,
    durable: Durable,
    view: View,
    cut: usize,
    shape: Shape,
}

impl Fixture {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn create(shape: Shape, size: usize, moved: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let key = SessionRef::new(shape.runner(), shape.harness(), "notice-cost");
        let cut = size - HELD;
        let entries: Vec<_> = (1..=size)
            .map(|n| {
                if n == 1 && matches!(shape, Shape::Pi) {
                    entry(1, Role::User, vec![])
                } else {
                    let offset = if n > cut { n - cut - 1 } else { n - 1 };
                    cycle(shape, n as u64, offset)
                }
            })
            .collect();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        db.with_connection(|conn| {
            let tx = conn.transaction().unwrap();
            for (sequence, start) in (1..=cut).step_by(500).enumerate() {
                let end = (start + 499).min(cut);
                tx.execute(
                    "INSERT INTO compartments (session_id, harness, sequence, start_message, end_message,
                       start_message_id, end_message_id, title, content, p1, p2, p3, p4, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, 1)",
                    params![key.session, key.harness, sequence as i64, start as i64, end as i64,
                        entries[start - 1].mid, entries[end - 1].mid,
                        format!("Reviewed component batch {sequence}"),
                        "Inspected implementation, preserved cache boundaries, and verified focused tests. ".repeat(20),
                        "Compatible implementation with focused verification. ".repeat(12),
                        "Preserved the public API and verified the focused tests. ".repeat(4),
                        "Reviewed implementation; public API and cache boundaries preserved."],
                ).unwrap();
            }
            tx.execute("INSERT INTO tags (session_id, harness, message_id, type, tag_number) VALUES (?1, ?2, ?3, 'message', ?4)",
                params![key.session, key.harness, entries[cut - 1].mid, cut as i64 * 3 + 2]).unwrap();
            tx.commit().unwrap();
            // A long-running head already indexed its archived transcript.
            mc_module::search::messages::index(conn, &key.harness, &key.session, &entries).unwrap();
        });
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let settings = Settings::default();
        let newest = cursor(&entries[cut - 1]);
        let view = if moved {
            drop(store);
            drop(db);
            let request = json!({"session":key,"preset":"head","project":null,"model":model(),
                "context_window":WINDOW,"output_reserve":RESERVE,"rules":rules(),"newest":newest,"now":1});
            let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_ck-mc"))
                .arg("move-in")
                .current_dir(dir.path())
                .env("HOME", dir.path())
                .env("XDG_CONFIG_HOME", dir.path())
                .env("XDG_DATA_HOME", dir.path())
                .env("MAGIC_CONTEXT_DB", dir.path().join("context.db"))
                .env("MAGIC_CONTEXT_MODE3_STORE", dir.path().join("mode3.db"))
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(&serde_json::to_vec(&request).unwrap())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let moved: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(moved["tag_checkpoint"], cut as u64 * 3 + 2);
            assert!(entries[cut..]
                .iter()
                .flat_map(|e| &e.parts)
                .filter_map(|p| p.tag)
                .all(|tag| tag > moved["tag_checkpoint"].as_u64().unwrap()));
            serde_json::from_value(moved["view"].clone()).unwrap()
        } else {
            // Seed an already-compacted native head. Only the moved row runs
            // the offline move-in command that retires the standalone plugin.
            let route = Route {
                session: key.clone(),
                project: None,
                workdir: None,
                agent_id: None,
            };
            let setup = SetupRequest::new("head", model(), WINDOW, RESERVE, rules(), vec![], 1)
                .with_newest(newest.clone());
            let mut session = Session::new(
                &route,
                &setup,
                mc_module::preset::features("head").unwrap(),
                Some(Arc::new(db)),
            );
            session.load_summaries();
            let view = session.first_view_after_move(&settings, &newest).unwrap();
            store.save(&key, &session.durable()).unwrap();
            view
        };
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        let durable = store.load(&key).unwrap();
        Self {
            dir,
            key,
            entries: Arc::new(entries),
            durable,
            view,
            cut,
            shape,
        }
    }

    fn reset(&self) {
        let db = ContextDb::open(&self.path("context.db")).unwrap();
        db.with_connection(|conn| {
            mc_module::search::messages::forget_from(
                conn,
                &self.key.harness,
                &self.key.session,
                self.entries.len() as u64 + 1,
            )
            .unwrap()
        });
        let conn = Connection::open(self.path("mode3.db")).unwrap();
        conn.execute_batch("DELETE FROM app_read_snapshots; DELETE FROM app_read_decisions;")
            .unwrap();
        conn.execute(
            "DELETE FROM app_read_message_index WHERE ordinal > ?1",
            [self.entries.len() as i64],
        )
        .unwrap();
        Store::open(&self.path("mode3.db"))
            .unwrap()
            .save(&self.key, &self.durable)
            .unwrap();
    }
}

fn cpu_us() -> u64 {
    let mut usage = std::mem::MaybeUninit::<nix::libc::rusage>::uninit();
    // getrusage initializes the entire structure on success. RUSAGE_SELF
    // includes both the session worker and the app-read replica thread.
    let usage = unsafe {
        assert_eq!(
            nix::libc::getrusage(nix::libc::RUSAGE_SELF, usage.as_mut_ptr()),
            0
        );
        usage.assume_init()
    };
    (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) as u64 * 1_000_000
        + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) as u64
}

async fn drain(module: &Module<Client>, key: &SessionRef) {
    module.idle(key).await.unwrap();
    // idle drains the session worker; this FIFO read additionally drains its
    // independent app projection. Its small metadata read is included in CPU.
    let meta = module
        .app_read()
        .read("session_data.read", json!({"section":"meta","session":key}))
        .await
        .unwrap();
    assert_eq!(meta["row"]["compartment_in_progress"], false);
}

fn request(client: &Client, seq: u64, entries: Vec<Entry>, threshold: bool) -> NoticeRequest {
    let conditions: Conditions = serde_json::from_value(json!({
        "model":model(),"context_window":WINDOW,"output_reserve":RESERVE,"rules":rules(),"now":2_000_000,
        "last_prompt_tokens": if threshold { 566_800 } else { 436_000 }
    })).unwrap();
    let mut request = NoticeRequest::new(seq, conditions).with_newest(client.newest());
    request.applied_view = Some(client.applied());
    request.entries = entries;
    request
}

async fn notice(module: &Module<Client>, key: &SessionRef, request: NoticeRequest) {
    assert_eq!(module.notice(key, request).unwrap(), NoticeAnswer::Received);
    drain(module, key).await;
}

fn trial(fixture: &Fixture, threshold: bool) -> (u64, u64, Vec<u64>, u64) {
    fixture.reset();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let client = Client(Arc::new(Mutex::new(RunnerState {
            original: fixture.entries.clone(),
            added: vec![],
            view: fixture.view.clone(),
            offered: 0,
        })));
        let route = Route {
            session: fixture.key.clone(),
            project: None,
            workdir: None,
            agent_id: None,
        };
        let mut setup = SetupRequest::new("head", model(), WINDOW, RESERVE, rules(), vec![], 1)
            .with_newest(client.newest());
        setup.applied_view = Some(client.applied());
        let before = cpu_us();
        let module = Module::new(
            client.clone(),
            Settings::default(),
            Some(ContextDb::open(&fixture.path("context.db")).unwrap()),
            Some(Store::open(&fixture.path("mode3.db")).unwrap()),
        );
        module.setup(route.clone(), setup).unwrap();
        drain(&module, &fixture.key).await;
        let setup_cpu = cpu_us() - before;
        let mut warm = Vec::new();
        for seq in 1..=WARM_STEPS {
            let entries = client.step(fixture.shape);
            let request = request(&client, seq, entries, false);
            let before = cpu_us();
            notice(&module, &fixture.key, request).await;
            warm.push(cpu_us() - before);
        }
        let candidate = fixture.entries[fixture.cut + 1].parts[0].tag.unwrap();
        module
            .tool(&route, "ctx_reduce", json!({"drop":candidate.to_string()}))
            .await
            .unwrap();
        drain(&module, &fixture.key).await;
        let entries = client.step(fixture.shape);
        let request = request(&client, WARM_STEPS + 1, entries, threshold);
        let offered = client.0.lock().unwrap().offered;
        let wall = Instant::now();
        let before = cpu_us();
        notice(&module, &fixture.key, request).await;
        let cpu = cpu_us() - before;
        let wall = wall.elapsed().as_micros() as u64;
        let published = client.0.lock().unwrap().offered - offered;
        assert_eq!(published, usize::from(threshold), "wrong notice path");
        (cpu, wall, warm, setup_cpu)
    })
}

fn stats(values: &[u64]) -> Value {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    json!({"n":sorted.len(),"min":sorted[0],"median":(sorted[(sorted.len()-1)/2] as f64 + sorted[sorted.len()/2] as f64)/2.0,
        "p95":sorted[(sorted.len()*95).div_ceil(100)-1],"max":sorted[sorted.len()-1]})
}

#[test]
fn notice_cost_fixture_paths() {
    for (shape, moved) in [
        (Shape::Pi, false),
        (Shape::OpenCode2, false),
        (Shape::Pi, true),
    ] {
        let fixture = Fixture::create(shape, 1_000, moved);
        for threshold in [false, true] {
            let (cpu, _, warm, _) = trial(&fixture, threshold);
            assert!(cpu > 0);
            assert_eq!(warm.len(), WARM_STEPS as usize);
        }
    }
    assert_eq!(stats(&(1..=200).collect::<Vec<_>>())["p95"], 190);
}

#[test]
#[ignore = "opt-in release CPU measurement: 200 independent warmed steps per row"]
#[allow(
    clippy::assertions_on_constants,
    reason = "compile in debug builds, but refuse to measure them"
)]
fn notice_cost() {
    assert!(
        !cfg!(debug_assertions),
        "run this measurement with --release"
    );
    let mut rows = Vec::new();
    for shape in [Shape::Pi, Shape::OpenCode2] {
        // Paired sizes run back to back in this one process/job, not on
        // separately scheduled hosts. Each trial restores the same durable
        // snapshot so earlier trials cannot change the path under test. The
        // summarizer trigger still runs; the short raw tail needs no summary.
        for size in [1_000, 150_000] {
            let fixture = Fixture::create(shape, size, false);
            for threshold in [false, true] {
                rows.push(measure(&fixture, threshold, false));
            }
        }
    }
    let fixture = Fixture::create(Shape::Pi, 150_000, true);
    for threshold in [false, true] {
        rows.push(measure(&fixture, threshold, true));
    }
    if let Some(path) = std::env::var_os("NOTICE_COST_OUTPUT") {
        std::fs::write(Path::new(&path), serde_json::to_vec_pretty(&rows).unwrap()).unwrap();
    }
}

fn measure(fixture: &Fixture, threshold: bool, moved: bool) -> Value {
    let mut cpu = Vec::new();
    let mut wall = Vec::new();
    let mut warm = Vec::new();
    let mut setup = Vec::new();
    for _ in 0..TRIALS {
        let (c, w, ws, s) = trial(fixture, threshold);
        cpu.push(c);
        wall.push(w);
        warm.extend(ws);
        setup.push(s);
    }
    let row = json!({"shape":fixture.shape.harness(),"size":fixture.entries.len(),"moved":moved,
        "path":if threshold {"build_publish"} else {"quiet"},"held_before_warmup":HELD+1,
        "cpu_us":stats(&cpu),"wall_us":stats(&wall),"setup_cpu_us":stats(&setup),
        "warmup_cpu_us":stats(&warm),"warmup_steps_per_trial":WARM_STEPS,
        "steps_cpu_us":cpu,"steps_wall_us":wall,"warmup_steps_cpu_us":warm,"setup_steps_cpu_us":setup});
    println!("NOTICE_COST_ROW {row}");
    row
}
