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
    views: Vec<View>,
    record_views: bool,
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
        if state.record_views {
            state.views.push(request.view.clone());
        }
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
    shared_table: bool,
    table_rows: usize,
}

impl Fixture {
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn create(shape: Shape, size: usize, moved: bool) -> Self {
        Self::with_table(shape, size, moved, false)
    }

    fn with_table(shape: Shape, size: usize, moved: bool, shared_table: bool) -> Self {
        Self::with_corpus(
            shape,
            size,
            moved,
            if shared_table {
                150_000.max(size)
            } else {
                size
            },
        )
    }

    fn with_corpus(shape: Shape, size: usize, moved: bool, table_rows: usize) -> Self {
        let shared_table = table_rows > size;
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
            // Fixture construction is outside every sample. Avoid thousands
            // of durability syncs while seeding disposable archive rows, then
            // restore SQLite's normal FULL setting before any measured work.
            conn.pragma_update(None,"synchronous","OFF").unwrap();
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
            if table_rows > size {
                let other: Vec<_> = (1..=table_rows - size)
                    .map(|n| cycle(shape, n as u64, n - 1))
                    .collect();
                mc_module::search::messages::index(conn, &key.harness, "other-session", &other).unwrap();
            }
            conn.pragma_update(None,"synchronous","FULL").unwrap();
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
            shared_table,
            table_rows,
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
    module.idle_foreground(key).await.unwrap();
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

fn trial(fixture: &Fixture, threshold: bool) -> (u64, u64, Vec<u64>, u64, Value) {
    trial_recording(fixture, threshold, false)
}

fn trial_recording(
    fixture: &Fixture,
    threshold: bool,
    record_views: bool,
) -> (u64, u64, Vec<u64>, u64, Value) {
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
            views: Vec::new(),
            record_views,
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
        module.search_idle(&fixture.key).await.unwrap();
        let setup_cpu = cpu_us() - before;
        let mut warm = Vec::new();
        for seq in 1..=WARM_STEPS {
            let entries = client.step(fixture.shape);
            let request = request(&client, seq, entries, false);
            let before = cpu_us();
            notice(&module, &fixture.key, request).await;
            warm.push(cpu_us() - before);
            module.search_idle(&fixture.key).await.unwrap();
        }
        let candidate = fixture.entries[fixture.cut + 1].parts[0].tag.unwrap();
        module
            .tool(&route, "ctx_reduce", json!({"drop":candidate.to_string()}))
            .await
            .unwrap();
        drain(&module, &fixture.key).await;
        module.search_idle(&fixture.key).await.unwrap();
        let entries = client.step(fixture.shape);
        let request = request(&client, WARM_STEPS + 1, entries, threshold);
        let offered = client.0.lock().unwrap().offered;
        #[cfg(feature = "notice-cost-timing")]
        module.pause_search_measurement(true);
        #[cfg(feature = "notice-cost-timing")]
        if std::env::var_os("NOTICE_COST_STAGES").is_some() {
            mc_module::notice_cost_timing::begin();
        }
        let wall = Instant::now();
        let before = cpu_us();
        notice(&module, &fixture.key, request).await;
        let cpu = cpu_us() - before;
        let wall = wall.elapsed().as_micros() as u64;
        #[cfg(feature = "notice-cost-timing")]
        let stages = serde_json::to_value(mc_module::notice_cost_timing::take()).unwrap();
        #[cfg(not(feature = "notice-cost-timing"))]
        let stages = Value::Null;
        let bg_start = cpu_us();
        #[cfg(feature = "notice-cost-timing")]
        module.pause_search_measurement(false);
        module.search_idle(&fixture.key).await.unwrap();
        let background_cpu = cpu_us() - bg_start;
        let published = client.0.lock().unwrap().offered - offered;
        assert_eq!(published, usize::from(threshold), "wrong notice path");
        let views = client.0.lock().unwrap().views.clone();
        (
            cpu,
            wall,
            warm,
            setup_cpu,
            json!({"stages":stages,"views":views,"background_cpu_us":background_cpu}),
        )
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
            let (cpu, _, warm, _, _) = trial(&fixture, threshold);
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
        for size in [1_000, 150_000, 500_000] {
            let started = Instant::now();
            let fixture = Fixture::with_corpus(shape, size, false, 500_000);
            println!(
                "NOTICE_COST_SETUP shape={} size={size} table_rows=500000 wall_ms={}",
                shape.harness(),
                started.elapsed().as_millis()
            );
            for threshold in [false, true] {
                rows.push(measure(&fixture, threshold, false));
            }
        }
    }
    let moved = Fixture::with_corpus(Shape::Pi, 150_000, true, 500_000);
    for threshold in [false, true] {
        rows.push(measure(&moved, threshold, true));
    }
    for shape in [Shape::Pi, Shape::OpenCode2] {
        let fixture = Fixture::with_table(shape, 1_000, false, true);
        for threshold in [false, true] {
            rows.push(measure(&fixture, threshold, false));
        }
    }
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
    measure_count(
        fixture,
        threshold,
        moved,
        if fixture.entries.len() >= 500_000 {
            50
        } else {
            TRIALS
        },
    )
}

fn measure_count(fixture: &Fixture, threshold: bool, moved: bool, trials: usize) -> Value {
    let mut cpu = Vec::new();
    let mut wall = Vec::new();
    let mut warm = Vec::new();
    let mut setup = Vec::new();
    let mut stages = Vec::new();
    let mut background = Vec::new();
    for _ in 0..trials {
        let (c, w, ws, s, details) = trial(fixture, threshold);
        cpu.push(c);
        wall.push(w);
        warm.extend(ws);
        setup.push(s);
        background.push(details["background_cpu_us"].as_u64().unwrap());
        if !details["stages"].is_null() {
            stages.push(details["stages"].clone());
        }
    }
    let row = json!({"shape":fixture.shape.harness(),"size":fixture.entries.len(),"moved":moved,
        "path":if threshold {"build_publish"} else {"quiet"},"held_before_warmup":HELD+1,
        "shared_table":fixture.shared_table,"table_rows":fixture.table_rows,"stages":stages,
        "background_cpu_us":stats(&background),"background_steps_cpu_us":background,
        "cpu_us":stats(&cpu),"wall_us":stats(&wall),"setup_cpu_us":stats(&setup),
        "warmup_cpu_us":stats(&warm),"warmup_steps_per_trial":WARM_STEPS,
        "steps_cpu_us":cpu,"steps_wall_us":wall,"warmup_steps_cpu_us":warm,"setup_steps_cpu_us":setup});
    println!("NOTICE_COST_ROW {row}");
    row
}

#[test]
#[ignore = "opt-in stage attribution with notice-cost-timing enabled"]
#[cfg(feature = "notice-cost-timing")]
fn notice_cost_stages() {
    let trials = std::env::var("NOTICE_COST_STAGE_TRIALS")
        .map_or(50, |v| v.parse().expect("stage trial count"));
    for (size, shared) in [(1_000, true), (150_000, true), (1_000, false)] {
        let fixture = Fixture::with_table(Shape::Pi, size, false, shared);
        measure_count(&fixture, true, false, trials);
    }
}

#[test]
#[ignore = "compare serialized views against an explicit pre-change reference file"]
fn notice_cost_view_bytes() {
    let path = std::env::var_os("NOTICE_COST_VIEW_REFERENCE").map(PathBuf::from);
    let golden: Value = serde_json::from_str(include_str!(
        "../benches/fixtures/notice-cost-legacy-views.json"
    ))
    .unwrap();
    let mut views = Vec::new();
    for shape in [Shape::Pi, Shape::OpenCode2] {
        for (size, shared, moved) in [
            (1_000, false, false),
            (150_000, false, false),
            (1_000, true, false),
            (150_000, false, true),
        ] {
            let fixture = Fixture::with_table(shape, size, moved, shared);
            for threshold in [false, true] {
                let (_, _, _, _, details) = trial_recording(&fixture, threshold, true);
                let bytes = serde_json::to_vec(&details["views"]).unwrap();
                if path.is_none() {
                    let key = if !threshold {
                        "quiet"
                    } else if size == 1_000 {
                        "small"
                    } else {
                        "large"
                    };
                    assert_eq!(
                        bytes,
                        golden[key].as_str().unwrap().as_bytes(),
                        "pre-fix view bytes changed: {shape:?}/{size}/{shared}/{moved}/{threshold}"
                    );
                }
                views.push(bytes);
            }
        }
    }
    if std::env::var_os("NOTICE_COST_WRITE_REFERENCE").is_some() {
        std::fs::write(
            path.expect("reference output path"),
            serde_json::to_vec(&views).unwrap(),
        )
        .unwrap();
        println!("Wrote pre-change reference: {} byte arrays", views.len());
    } else if let Some(path) = path {
        let before: Vec<Vec<u8>> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(before.len(), views.len());
        for (index, (before, after)) in before.iter().zip(&views).enumerate() {
            assert_eq!(before, after, "view bytes changed at fixture/path {index}");
        }
        println!("All {} view byte arrays match the pre-change executable, including edit order, versions and checksums", views.len());
    } else {
        println!(
            "All {} view byte arrays exactly match the committed pre-fix executable fixture",
            views.len()
        );
    }
}

#[test]
#[ignore = "migrate only an explicitly supplied offline store copy"]
fn notice_cost_live_migration() {
    let path = PathBuf::from(
        std::env::var_os("NOTICE_COST_MIGRATION_COPY")
            .expect("supply an offline SQLite backup copy"),
    );
    let connection = Connection::open(&path).unwrap();
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(
        version, 3,
        "this proof starts at the deployed version-three store"
    );
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT runner,harness,session,state FROM sessions ORDER BY runner,harness,session",
            )
            .unwrap();
        statement
            .query_map([], |r| {
                Ok((
                    SessionRef::new(
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ),
                    r.get::<_, String>(3)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    let before: Vec<(SessionRef, Durable)> = rows
        .iter()
        .map(|(k, s)| (k.clone(), serde_json::from_str(s).unwrap()))
        .collect();
    drop(connection);
    let store = Store::open(&path).unwrap();
    for (index, (key, state)) in before.iter().enumerate() {
        assert_eq!(
            store.load(key).as_ref(),
            Some(state),
            "decoded state differs at offline-copy session {index}"
        );
        println!("offline-copy session row {index}: decoded equality PASS, baseline={}, pending_views={}",state.baseline.is_some(),state.unconfirmed.len());
    }
    println!(
        "Migrated offline copy 3 -> 4: {}/{} session Durable values exactly equal",
        before.len(),
        before.len()
    );
}

#[test]
#[ignore = "diagnose index commit tails, not an admission run or a production setting"]
#[cfg(feature = "notice-cost-timing")]
fn notice_cost_index_tail() {
    fn structure(conn: &Connection) -> Vec<u64> {
        let bytes: Vec<u8> = conn
            .query_row(
                "SELECT block FROM message_history_fts_data WHERE id=10",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut cursor = 4;
        let mut values = Vec::new();
        while cursor < bytes.len() {
            let mut value = 0u64;
            for shift in 0..9 {
                let byte = bytes[cursor];
                cursor += 1;
                if shift == 8 {
                    value = (value << 8) | u64::from(byte);
                    break;
                }
                value = (value << 7) | u64::from(byte & 127);
                if byte & 128 == 0 {
                    break;
                }
            }
            values.push(value);
        }
        values
    }
    for size in [1_000, 150_000] {
        for suppress_merges in [false, true] {
            let fixture = Fixture::with_table(Shape::Pi, size, false, true);
            let db = ContextDb::open(&fixture.path("context.db")).unwrap();
            let mut rows = Vec::new();
            db.with_connection(|conn| {
                let mode:String=conn.pragma_query_value(None,"journal_mode",|r|r.get(0)).unwrap();
                if suppress_merges {
                    // A diagnostic intervention only: compare the unchanged
                    // index function with FTS merge work deferred beyond this
                    // short probe. No production connection uses these values.
                    conn.execute_batch("INSERT INTO message_history_fts(message_history_fts,rank) VALUES('automerge',0); INSERT INTO message_history_fts(message_history_fts,rank) VALUES('crisismerge',1000000);").unwrap();
                }
                let pending=vec![fixture.entries.last().unwrap().clone(),assistant(size as u64+1,2_048),entry(size as u64+2,Role::User,vec![])];
                for step in 0..203 {
                    mc_module::search::messages::forget_from(conn,&fixture.key.harness,&fixture.key.session,size as u64+1).unwrap();
                    let before=structure(conn);
                    mc_module::notice_cost_timing::begin();
                    let start=cpu_us();
                    mc_module::search::messages::index(conn,&fixture.key.harness,&fixture.key.session,&pending).unwrap();
                    let cpu=cpu_us()-start;
                    let stages=mc_module::notice_cost_timing::take();
                    let after=structure(conn);
                    if step>=3 { rows.push(json!({"step":step-3,"cpu_us":cpu,"before":before,"after":after,"stages":stages})); }
                }
                let cpus:Vec<_>=rows.iter().map(|r|r["cpu_us"].as_u64().unwrap()).collect();
                println!("NOTICE_COST_TAIL {}",json!({"size":size,"table_rows":150000,"journal_mode":mode,"diagnostic_merges_suppressed":suppress_merges,"cpu_us":stats(&cpus),"steps":rows}));
            });
        }
    }
}

/// Focused CPU attribution after a size ratio fails, without changing any
/// production function. The message-index probe includes the boundary-row
/// lookup and new rows; the store probes isolate serialization and persistence
/// of the cached history text, which contains more summaries in larger sessions.
#[test]
#[ignore = "opt-in component CPU attribution after notice_cost exceeds its size-ratio budget"]
fn notice_cost_profile() {
    for shape in [Shape::Pi, Shape::OpenCode2] {
        for size in [1_000, 150_000] {
            let fixture = Fixture::create(shape, size, false);
            let db = ContextDb::open(&fixture.path("context.db")).unwrap();
            let store = Store::open(&fixture.path("mode3.db")).unwrap();
            let mut pending = vec![fixture.entries.last().unwrap().clone()];
            pending.push(assistant(size as u64 + 1, 2_048));
            if matches!(shape, Shape::Pi) {
                pending.push(entry(size as u64 + 2, Role::User, vec![]));
            }
            let mut indexing = Vec::new();
            let mut saving = Vec::new();
            let mut serialization = Vec::new();
            for iteration in 0..TRIALS + WARM_STEPS as usize {
                db.with_connection(|conn| {
                    mc_module::search::messages::forget_from(
                        conn,
                        &fixture.key.harness,
                        &fixture.key.session,
                        size as u64 + 1,
                    )
                    .unwrap();
                    let before = cpu_us();
                    mc_module::search::messages::index(
                        conn,
                        &fixture.key.harness,
                        &fixture.key.session,
                        &pending,
                    )
                    .unwrap();
                    let cpu = cpu_us() - before;
                    if iteration >= WARM_STEPS as usize {
                        indexing.push(cpu);
                    }
                });
                let before = cpu_us();
                std::hint::black_box(serde_json::to_string(&fixture.durable).unwrap());
                let cpu = cpu_us() - before;
                if iteration >= WARM_STEPS as usize {
                    serialization.push(cpu);
                }
                let before = cpu_us();
                store.save(&fixture.key, &fixture.durable).unwrap();
                let cpu = cpu_us() - before;
                if iteration >= WARM_STEPS as usize {
                    saving.push(cpu);
                }
            }
            let plan = db.with_connection(|conn| {
                let mut statement = conn.prepare("EXPLAIN QUERY PLAN SELECT message_id, normalized_content_hash FROM message_history_source WHERE session_id = ?1 AND message_ordinal = ?2").unwrap();
                statement.query_map(params![fixture.key.session, size as i64], |row| row.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>, _>>().unwrap()
            });
            println!(
                "NOTICE_COST_PROFILE {}",
                json!({"shape":shape.harness(),"size":size,
                "messages_index_cpu_us":stats(&indexing),"store_save_cpu_us":stats(&saving),
                "durable_json_cpu_us":stats(&serialization),"durable_json_bytes":serde_json::to_vec(&fixture.durable).unwrap().len(),
                "boundary_lookup_plan":plan})
            );
        }
    }
}
