//! Regression tests for defects found before ck-mc served runner-hosted
//! sessions: a quoted tag in the history head, a summary over a call left
//! running, an `m[1]` rewrite for another writer's memory alone, a restart
//! whose applied-view read failed, an answered image quoting a tag, signed
//! parts replaced, a tool-result record ending the turn, and the age-sweep
//! bookmark surviving an undo. Each test failed before its fix.
//!
//! The scenario tests drive ck-mc in process against the mock runner
//! (`mc-mock-runner`), with a trimmed copy of the harness in
//! `tests/scenarios.rs`, whose helpers are private to its own test crate.
//! The others call ck-mc's public lane, pass and view-building functions
//! directly, with transcripts built by hand, for shapes the mock runner
//! cannot produce.

use std::sync::{Arc, Mutex};

use cortexkit_role_compaction::notice::{Conditions, NoticeAnswer, NoticeRequest};
use cortexkit_role_compaction::part::{Part, PartBody, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{Entry, ReadPage, ReadRequest, Role, SessionRef, StepUsage};
use cortexkit_role_compaction::ride::{RideAnswer, RideRequest};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupAnswer, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{RouteRef, RunnerRef, SelectAnswer, SelectRequest};
use mc_mock_runner::model::Kind;
use mc_mock_runner::runner::{CallError, Host, Provider, Runner, SessionConfig, UserEdit};
use mc_mock_runner::script::{Step, ToolCall, Turn};
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::index::Index;
use mc_module::lanes::{self, placeholder, Edited, Shape};
use mc_module::module::{Module, ModuleError};
use mc_module::pass::{self, Settings};
use mc_module::route::{Project as RouteProject, Route};
use mc_module::routing::{RouteError, Router};
use mc_module::store::Store;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Harness: ck-mc's calls back into the mock runner, as in tests/scenarios.rs.
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct HostClient {
    host: Arc<Mutex<Option<Host>>>,
    /// The version of every view ck-mc handed over with `session.apply_view`.
    offered: Arc<Mutex<Vec<u64>>>,
    /// While set, `session.applied_view` fails, as a runner call that times
    /// out does. Every other call still works.
    fail_applied_view: Arc<Mutex<bool>>,
}

impl HostClient {
    fn host(&self) -> Result<Host, ClientError> {
        self.host
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| ClientError::new("runner not attached"))
    }
}

/// A stand-in routing provider: always the session's own test model, with a
/// window large enough for a summarizer prompt.
impl Router for HostClient {
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

/// A request as the runner decodes it from its JSON.
fn through_wire<T: serde::Serialize + serde::de::DeserializeOwned>(value: &T) -> T {
    serde_json::from_value(serde_json::to_value(value).expect("requests serialize"))
        .expect("the runner decodes what ck-mc sends")
}

/// An llm-runner answer as ck-mc reads it: wrapped as `{"result": …}`.
fn read_wrapped<T: serde::Serialize, A: serde::de::DeserializeOwned>(
    answer: &T,
) -> Result<A, ClientError> {
    let body = cortexkit_role_llm_runner::wire::reply_body(answer).expect("answers serialize");
    cortexkit_role_llm_runner::wire::read_reply(&body)
        .map_err(|error| ClientError::new(format!("{error:?}")))
}

impl RunnerClient for HostClient {
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
        if *self.fail_applied_view.lock().unwrap() {
            return Err(ClientError::new("session.applied_view timed out"));
        }
        Ok(self.host()?.applied_view())
    }

    async fn send(
        &self,
        session: &SessionRef,
        request: SendRequest,
    ) -> Result<SendReply, ClientError> {
        let request: SendRequest = through_wire(&request);
        let reply = self
            .host()?
            .send(&session.session, request)
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
        let request: RunResultRequest = through_wire(&request);
        let result = self
            .host()?
            .run_result(&request)
            .ok_or_else(|| ClientError::new(format!("unknown run {}", request.run_id)))?;
        read_wrapped(&result)
    }
}

/// ck-mc in process, reached on one session's routes. Each notice is handled
/// before the runner's next step, which keeps the assertions exact. The
/// module can be replaced, as a ck-mc restart on the same stores does.
struct InProcess {
    module: Mutex<Module<HostClient>>,
    route: Route,
    client: HostClient,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
}

impl InProcess {
    fn module(&self) -> Module<HostClient> {
        self.module.lock().unwrap().clone()
    }

    fn new_module(
        client: HostClient,
        settings: Settings,
        stores: Option<&std::path::Path>,
    ) -> Module<HostClient> {
        let (db, store) = match stores {
            Some(dir) => {
                let db_path = dir.join("context.db");
                let db = if db_path.exists() {
                    ContextDb::open(&db_path).unwrap()
                } else {
                    ContextDb::create_for_tests(&db_path).unwrap()
                };
                (Some(db), Some(Store::open(&dir.join("mode3.db")).unwrap()))
            }
            None => (None, None),
        };
        Module::new(client, settings, db, store)
    }

    /// ck-mc restarts: a new process on the same stores, with no sessions
    /// until the runner calls Setup again.
    fn restart(&self) {
        *self.module.lock().unwrap() = Self::new_module(
            self.client.clone(),
            self.settings.clone(),
            self.stores.as_deref(),
        );
    }
}

fn call_error(error: ModuleError) -> CallError {
    use cortexkit_role_compaction::wire::codes;
    match error {
        ModuleError::Tool(text) => CallError::new(text),
        ModuleError::UnknownPreset(preset) => CallError::refused(codes::UNKNOWN_PRESET, preset),
        ModuleError::UnknownSession => CallError::refused(codes::UNKNOWN_SESSION, "no Setup"),
        other => CallError::new(format!("{other:?}")),
    }
}

impl Provider for InProcess {
    async fn setup(&self, request: SetupRequest) -> Result<SetupAnswer, CallError> {
        self.module()
            .setup(self.route.clone(), request)
            .map_err(call_error)
    }

    async fn notice(&self, request: NoticeRequest) -> Result<NoticeAnswer, CallError> {
        let session = &self.route.session;
        let module = self.module();
        let answer = module.notice(session, request).map_err(call_error)?;
        if answer == NoticeAnswer::Received {
            module.idle(session).await.map_err(call_error)?;
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

    async fn pre_user(&self, _: &str, _: u64) -> Result<UserEdit, CallError> {
        Ok(UserEdit::default())
    }
}

fn free() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn bound() -> ProviderRules {
    ProviderRules::new(SignedParts::Bound, EditCost::Suffix)
}

/// The scenario suite's session: a worker's usable window is 39,000 tokens
/// (execute threshold 25,350), a head's 99,000 (threshold 64,350).
fn config(preset: &str) -> SessionConfig {
    SessionConfig {
        session: SessionRef::new("mock-runner", "mock", "s1"),
        preset: preset.into(),
        model: ModelRef::new("test", "test-model"),
        context_window: if preset == "head" { 100_000 } else { 40_000 },
        output_reserve: 1_000,
        rules: free(),
        kind: Kind::OpenAi,
        cache_ttl_ms: 300_000,
        system_tokens: 500,
        tag_checkpoint: 0,
        moved_in: None,
        start_ms: 1_000_000,
        project: None,
        model_latency_ms: 0,
        templates: mc_module::nudges::templates(),
        accepts_images: None,
        view_anchor: true,
    }
}

/// A head with its own project folder `dir`, whose `context.db` and
/// `mode3.db` ck-mc uses.
fn head_in(dir: &std::path::Path) -> SessionConfig {
    let mut config = config("head");
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    config
}

async fn start(config: SessionConfig, stores: Option<std::path::PathBuf>) -> Runner<InProcess> {
    start_with(config, Settings::default(), stores).await
}

async fn start_with(
    config: SessionConfig,
    settings: Settings,
    stores: Option<std::path::PathBuf>,
) -> Runner<InProcess> {
    let client = HostClient::default();
    let route = Route {
        session: config.session.clone(),
        project: config.project.as_ref().map(|project| RouteProject {
            id: project.id.clone(),
            root: project.root.clone(),
        }),
        workdir: config.project.as_ref().map(|project| project.root.clone()),
        agent_id: None,
    };
    let provider = InProcess {
        module: Mutex::new(InProcess::new_module(
            client.clone(),
            settings.clone(),
            stores.as_deref(),
        )),
        route,
        client,
        settings,
        stores,
    };
    let runner = Runner::start(config, provider).await.unwrap();
    *runner.provider().client.host.lock().unwrap() = Some(runner.host().clone());
    runner
}

/// A fresh scratch folder for one test's stores.
fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("ck-mc-audit-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    dir
}

/// Store a project memory the way another session or the plugin would.
fn insert_memory(dir: &std::path::Path, id: i64, content: &str) {
    let connection = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    connection
        .execute(
            "INSERT INTO memories (id, project_path, category, content, normalized_hash, importance,
                                   first_seen_at, created_at, updated_at, last_seen_at)
             VALUES (?1, 'pj-test', 'PROJECT_RULES', ?2, ?3, 80, 1, 1, 1, 1)",
            rusqlite::params![id, content, format!("hash-{id}")],
        )
        .unwrap();
}

fn user(text: &str) -> Step {
    Step::User { text: text.into() }
}

fn answer() -> Step {
    Step::Model(Turn {
        text: Some("Done.".into()),
        output_tokens: 5,
        ..Turn::default()
    })
}

/// A worker's read step: some reasoning, a sentence (one tag) and a `read`
/// whose result is about 7,000 tokens (one tag).
fn read_file() -> Step {
    Step::Model(Turn {
        reasoning_tokens: Some(50),
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "x".repeat(28_000),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn reduce(spec: &str) -> Step {
    Step::Model(Turn {
        text: Some("Those are done.".into()),
        tools: vec![ToolCall::ok("ctx_reduce", json!({"drop": spec}), "")],
        output_tokens: 10,
        ..Turn::default()
    })
}

/// A head's read step: a sentence and a `read` of about 12,000 tokens.
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

/// A head's turn: a prompt, two large reads and an answer. Three turns take
/// a head past its execute threshold and start a summary.
fn turn(prompt: &str) -> Vec<Step> {
    vec![user(prompt), large_read(), large_read(), answer()]
}

/// The start of the text the model sees for the part numbered `tag`.
fn seen(host: &Host, tag: u64) -> Option<String> {
    host.rendered().iter().find_map(|message| {
        message
            .parts
            .iter()
            .find(|part| part.tag == Some(tag))
            .and_then(|part| message.wire_text(part))
            .map(|text| text.chars().take(60).collect())
    })
}

/// The texts of the two history messages at the start of the request.
fn head_texts(host: &Host) -> (String, String) {
    let rendered = host.rendered();
    let text = |index: usize| -> String {
        let message = &rendered[index];
        message
            .parts
            .iter()
            .filter_map(|part| message.wire_text(part))
            .collect()
    };
    (text(0), text(1))
}

// ---------------------------------------------------------------------------
// 1. Tag notation in the history head's sources.
// ---------------------------------------------------------------------------

/// The runner refuses a view whose inserted message contains a tag prefix
/// (`§`, digits, `§`; compaction contract W6.4 and W6.5 `tagged_insert`), and
/// the contract says "The provider strips them before it renders the history
/// head." ck-mc never strips them: `render_head` (`session.rs`) copies
/// summaries, memories, the user profile and project docs into `m[0]` and
/// `m[1]` as they are. ck-mc's own check in `view_builder::next_view` then
/// refuses the view, `seal` logs "no valid view", sets every part the pass
/// covered aside for good, and publishes nothing. Every later pass renders
/// the same head, so the session never publishes a view again: no summary
/// lands, no drop lands, and the context grows until the runner refuses the
/// turn. A memory that quotes a placeholder, a summary of a person asking
/// for "§12§", or a profile line is enough.
///
/// Passes when the head still lands with the tag notation taken out: the
/// new session's first request carries view 1, and `m[0]` shows the memory
/// without `§7§`.
#[tokio::test]
async fn a_memory_that_quotes_a_tag_number_does_not_stop_the_head_from_landing() {
    let dir = scratch("tagged-memory");
    insert_memory(
        &dir,
        1,
        "A dropped result reads [dropped §7§]; ctx_expand brings it back.",
    );
    let mut runner = start(head_in(&dir), Some(dir.clone())).await;
    runner.play(&[user("Hello."), answer()]).await;
    let first_view = runner.report.requests[0].view;
    assert_eq!(
        first_view,
        Some(1),
        "the head never landed: ck-mc refused its own view because m[0] quotes §7§"
    );
    let (m0, _) = head_texts(runner.host());
    assert!(m0.contains("#1:"), "{m0}");
    assert!(!m0.contains("§7§"), "{m0}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 2. A summary that covers a tool call left running.
// ---------------------------------------------------------------------------

/// The summarizer reads past a tool call left running in a message older
/// than its protected tail (`trigger::tail_start`: "a call still running in
/// a message older than the tail was interrupted, and is summarized as it
/// stands"; spec 3 CH4). The cut then goes through that message, and the
/// view library refuses a cut over a running call (`render::plan`,
/// `running_tool`; contract W6.5: "A tool still running cannot be dropped,
/// replaced or cut"). ck-mc's own check fails the view; the next pass builds
/// the same cut, and every pass after it too, so no view lands again. A
/// runner that crashed during a tool, or a call still waiting for approval,
/// leaves such a call.
///
/// Passes when the session keeps publishing views after such a summary. In
/// this script the mock summarizer's first run covers message 1 and lands
/// with view 2; its second covers messages 2 and 3, the running call among
/// them. With the call completed instead, view 3 lands with that summary
/// and the prompt falls to about 37,000 tokens. With the call running, no
/// view after 2 ever lands and the prompt grows past the force band (85% of
/// 99,000) with nothing reclaimed.
#[tokio::test]
async fn a_summary_over_a_call_left_running_still_lands_a_view() {
    let mut runner = start(config("head"), None).await;
    let interrupted = Step::Model(Turn {
        reasoning_tokens: Some(50),
        text: Some("Running the build.".into()),
        tools: vec![ToolCall {
            name: "bash".into(),
            input: json!({"command": "cargo build"}),
            output: String::new(),
            status: ToolStatus::Running,
            images: 0,
        }],
        output_tokens: 20,
        ..Turn::default()
    });
    let mut steps = vec![
        user("Look at a.rs."),
        interrupted,
        large_read(),
        large_read(),
        answer(),
    ];
    for prompt in ["Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.extend([answer(), answer()]);
    runner.play(&steps).await;
    runner.play(&[large_read(), answer(), answer()]).await;
    let host = runner.host();
    // Precondition: the summarizer ran more than once, so a summary covers
    // the message holding the running call.
    assert!(
        host.child_runs().len() >= 2,
        "{} summarizer runs",
        host.child_runs().len()
    );
    let last_prompt = runner.report.requests.last().unwrap().usage.prompt_tokens;
    assert!(
        host.applied_version().unwrap_or(0) >= 3,
        "no view after the first summary's ever landed (applied view {:?}, offered {:?}, \
         last prompt {last_prompt:?} tokens): every view after the summary over the \
         running call fails ck-mc's own check",
        host.applied_version(),
        runner.provider().client.offered.lock().unwrap()
    );
}

// ---------------------------------------------------------------------------
// 3. A restart whose `session.applied_view` read fails.
// ---------------------------------------------------------------------------

/// ck-mc does not save the view the runner applies (`Durable` has no
/// `latest`); after a restart `restore` takes it only from views still
/// waiting for confirmation, so a session whose views were all confirmed
/// restarts with no view at all, and Setup reads the runner's with
/// `session.applied_view` (`adopt_runner_view`). When that read fails, the
/// failure is logged and the pass goes on: `build` starts from no previous
/// view (`next_view(None, …)`), so the next view carries only this pass's
/// edits. The runner takes it (a new view need not repeat the old one's
/// edits to pass its checks) and every part the earlier views dropped is
/// sent again: the context grows back by everything ever dropped, and the
/// cache is rewritten from the first of them. Contract V2 and spec 2 PD11:
/// "Views are cumulative: a view carries every edit of the previous one, and
/// an edit is only undone by a revert."
///
/// Passes when the sentences dropped before the restart (tags 2 and 4) stay
/// dropped after it, for example because ck-mc builds no view while it does
/// not know the runner's.
#[tokio::test]
async fn a_failed_applied_view_read_after_a_restart_never_undoes_earlier_drops() {
    let dir = scratch("restart-adopt");
    let mut runner = start(config("worker"), Some(dir.clone())).await;
    // Tags: task 1; reads 2/3 and 4/5; the reduce step 6/7; reads 8/9 and
    // 10/11 take the worker over its threshold, and the first execute pass
    // lands the drops of the sentences at tags 2 and 4.
    runner
        .play(&[
            user("Review the module."),
            read_file(),
            read_file(),
            reduce("2,4"),
            read_file(),
            read_file(),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    let host = runner.host().clone();
    assert_eq!(seen(&host, 2).as_deref(), Some(placeholder(2).as_str()));
    assert_eq!(seen(&host, 4).as_deref(), Some(placeholder(4).as_str()));

    // ck-mc restarts; the runner's next notice is answered "Setup required"
    // and it calls Setup again. Its `session.applied_view` answers time out.
    *runner.provider().client.fail_applied_view.lock().unwrap() = true;
    runner.provider().restart();
    // The model asks for one more drop, which the next execute pass lands.
    runner
        .play(&[
            reduce("8"),
            read_file(),
            read_file(),
            read_file(),
            answer(),
            answer(),
        ])
        .await;
    let host = runner.host();
    assert_eq!(
        seen(host, 2).as_deref(),
        Some(placeholder(2).as_str()),
        "a dropped sentence came back after the restart (applied view {:?})",
        host.applied_version()
    );
    assert_eq!(seen(host, 4).as_deref(), Some(placeholder(4).as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 4. A memory written elsewhere rewrites a head's cache at the threshold.
// ---------------------------------------------------------------------------

/// At or above the execute threshold, with no summary on its way, every
/// notice builds (`decide_notice`). `render_head` re-reads the project's
/// memories, and `m[1]` states every change since the fold, whoever made
/// it (spec 3 HD4). So a memory any other session, historian or dreamer
/// saves in the same project changes `m[1]`, and that alone makes the view
/// builder publish a view (`replaced_in_place`): the request is rewritten
/// from `m[1]`, its second message, so the whole conversation is written to
/// the cache again. Spec 2 PD3 lands "the history refresh" with a summary
/// and otherwise "every lane", and PD12 says "A pass whose lanes have no new
/// edit publishes nothing, even with rebuild permission". The plugin's soft
/// refresh never reads other writers' memory rows
/// (`inject-compartments.ts` `renderSoftM1` reads this session's agent
/// fragments and dashboard edits only), so in the plugin such a pass
/// changes nothing. In a project several sessions share, where every
/// summary promotes facts to memories, a head that stays over its threshold
/// pays a full cache write for each of them.
///
/// The head here is over its threshold on one long prompt and two long
/// replies: the prompt stays raw (spec 3 CH3) and nothing before it can be
/// summarized, and no lane has work, so its passes rightly publish nothing.
/// Then another writer saves a memory.
///
/// Passes when that memory alone hands over no view: it waits in `m[1]`
/// for the next pass that rewrites anyway.
#[tokio::test]
async fn a_memory_saved_elsewhere_alone_publishes_no_view_over_the_threshold() {
    let dir = scratch("foreign-memory");
    insert_memory(&dir, 1, "Ask before pushing.");
    let mut runner = start(head_in(&dir), Some(dir.clone())).await;
    let long_reply = || {
        Step::Model(Turn {
            text: Some("z".repeat(10_000)),
            output_tokens: 2_500,
            ..Turn::default()
        })
    };
    runner
        .play(&[
            user(&format!("Review this. {}", "w".repeat(240_000))),
            long_reply(),
            long_reply(),
            answer(),
            answer(),
        ])
        .await;
    let last = runner.report.requests.last().unwrap().clone();
    let prompt = last.usage.prompt_tokens.unwrap();
    // Over the head's threshold (64,350 of 99,000), under its force band.
    assert!((64_350..84_150).contains(&prompt), "prompt {prompt}");
    assert!(runner.host().child_runs().is_empty(), "a summary ran");
    let offered_before = runner.provider().client.offered.lock().unwrap().clone();

    insert_memory(&dir, 2, "Never force-push.");
    runner.play(&[answer(), answer()]).await;
    let offered = runner.provider().client.offered.lock().unwrap().clone();
    let (_, m1) = head_texts(runner.host());
    assert_eq!(
        offered, offered_before,
        "a memory saved by another writer handed over a view by itself; m[1] is now {m1}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 5. Unit witnesses: shapes the mock runner cannot produce.
// ---------------------------------------------------------------------------

fn text(id: &str, tag: u64, body: &str) -> Part {
    Part::new(id, PartBody::Text { text: body.into() }).with_tag(tag)
}

/// An entry built from parts already numbered and sealed.
fn entry(ordinal: u64, mid: &str, role: Role, parts: Vec<Part>) -> Entry {
    Entry::new(ordinal, mid, role, ordinal * 1_000, parts)
}

/// `pass::current_turn_start` takes the turn to start after the newest
/// user entry without a notice, whatever it holds. Under the contract a
/// record that only carries tool results is an entry with no parts (W4.1:
/// "a Pi `toolResult`, a Claude Code user message holding only tool
/// results, a host's tool-role message holding a batch's results"), so on
/// a runner that gives such a record the user role every tool round ends
/// the "turn". The plugin's boundary skips exactly those carriers
/// (`active-anthropic-turn.ts`: a user whose parts are all tool results
/// does not end the turn), and ck-mc's own other turn tests require text
/// (`lanes::starts_user_turn`, `trigger::is_meaningful_user`). Two rules
/// follow from the wrong boundary: the signed-thinking hold (spec 2 PD10)
/// sees only the steps after the last tool round, so it almost never
/// holds, and the reasoning budget's Anthropic exemption (RC1) protects
/// only those steps, so the current turn's thinking can be cleared.
///
/// Passes when the hold sees the heavy step before the tool-result record:
/// the person's prompt, a step that thought 3,000 tokens and called a
/// tool, the record carrying that tool's result, and a short answer, at 70%
/// usage on a bound model, is held.
#[test]
fn a_tool_result_record_does_not_end_the_turn_for_the_signed_thinking_hold() {
    let tool = Part::new(
        "c1",
        PartBody::Tool(ToolPart::new(
            "call-1",
            "read",
            json!({"path": "a.rs"}),
            ToolStatus::Completed,
        )),
    )
    .with_tag(2);
    let thinking = Part::new(
        "r1",
        PartBody::Reasoning {
            text: None,
            text_bytes: None,
        },
    )
    .with_seal(Seal::Signed);
    let entries = vec![
        entry(
            1,
            "u1",
            Role::User,
            vec![text("p1", 1, "Review the module.")],
        ),
        entry(2, "a1", Role::Assistant, vec![thinking, tool])
            .with_usage(StepUsage::default().with_reasoning_tokens(3_000)),
        // The record holding the read's result: no parts of its own.
        entry(3, "t1", Role::User, Vec::new()),
        entry(4, "a2", Role::Assistant, vec![text("p4", 3, "Read it.")]),
    ];
    let mut conditions = Conditions::new(
        ModelRef::new("anthropic", "claude-opus-5-5"),
        100_000,
        0,
        bound(),
    );
    conditions.last_prompt_tokens = Some(70_000);
    assert_eq!(
        pass::current_turn_start(&entries),
        Some(1),
        "the turn should start after the person's prompt, not after the tool-result record"
    );
    assert!(pass::signed_thinking_hold(
        &entries,
        &conditions,
        &Settings::default()
    ));
}

/// `lanes::drop_ops` turns a dropped text part into a `replace` with its
/// placeholder and a dropped recent small-input tool part into a `replace`
/// of its output, whatever the part's seal. A sealed part can be dropped but
/// never replaced (contract PR5, W4.3; the view library's `check_field`
/// refuses it with `bad_field`), and the contract marks Gemini's thought
/// signatures on text and tool calls `seal: signed` (W4.10). So on such a
/// session the view fails ck-mc's own check: `seal` throws away the whole
/// pass, every lane's work with it, and sets every part it covered aside for
/// good. The answered-images lane already skips sealed parts; the shared
/// drop path does not.
///
/// Passes when the edits `drop_ops` makes for a sealed text part and a
/// sealed tool part, next to an ordinary one, make a view that passes the
/// runner's checks (a sealed part dropped whole, or left alone).
#[test]
fn a_sealed_text_or_tool_part_never_gets_a_replace_the_runner_refuses() {
    let sealed_text = text("t2", 2, "I'll read the file.").with_seal(Seal::Signed);
    let mut call = ToolPart::new(
        "call-1",
        "read",
        json!({"path": "a.rs"}),
        ToolStatus::Completed,
    );
    call.output = Some("fn a() {}".into());
    call.output_bytes = Some(9);
    let sealed_tool = Part::new("c3", PartBody::Tool(call))
        .with_tag(3)
        .with_seal(Seal::Signed);
    let plain = text("t5", 5, "Now the next one.");
    let entries = vec![
        entry(
            1,
            "u1",
            Role::User,
            vec![text("p1", 1, "Review the module.")],
        ),
        entry(2, "a1", Role::Assistant, vec![sealed_text, sealed_tool]),
        entry(3, "u2", Role::User, vec![text("p4", 4, "Go on.")]),
        entry(4, "a2", Role::Assistant, vec![plain]),
        entry(5, "u3", Role::User, vec![text("p6", 6, "Thanks.")]),
    ];
    let mut index = Index::default();
    index.extend(entries.clone());
    let edited = Edited::default();
    let protected = std::collections::BTreeMap::new();
    let context = lanes::Context {
        index: &index,
        edited: &edited,
        protected_tools: &protected,
        keep_first_message: false,
    };
    let key = |mid: &str, part: &str| (mid.to_owned(), part.to_owned());
    let (ops, covered) = lanes::drop_ops(
        &context,
        &[
            (key("a1", "t2"), Shape::Requested),
            (key("a1", "c3"), Shape::Requested),
            (key("a2", "t5"), Shape::Requested),
        ],
    );
    assert!(covered.contains(&key("a2", "t5")));
    let built = mc_module::view_builder::next_view(None, &entries, ops, &free(), 1, |_| false);
    assert!(
        matches!(built, Ok(Some(_))),
        "the pass's view fails ck-mc's own check, losing the ordinary drop too: {built:?}"
    );
}

// ---------------------------------------------------------------------------
// 6. The age-sweep bookmark after an undo.
// ---------------------------------------------------------------------------

/// The age sweep drops every tool output at or below its bookmark, a tag
/// number (`lanes::age_sweep`), and the bookmark only ever grows
/// (`commit_bookmark`). Under the contract an undo frees the numbers it
/// removed and the next new parts take them again (T4: "a removed number is
/// given to the next new part"). Nothing lowers the bookmark on a
/// `transcript_changed` notice, so after an undo every new output whose
/// number is at or below the old bookmark counts as far behind at once and
/// goes on the next rebuild, skipping the rule that an output must be far
/// behind on an earlier rebuild first (spec 2 AS2), even when it is not far
/// behind at all. The lane that shortens an older edit of a file once a
/// newer edit of it exists (`lanes::superseded_edits`) also acts only at or
/// below this bookmark, so it fires early in the same way. The plugin
/// never reuses a number, and clamps the bookmark to the highest tag it
/// keeps when it copies a session (`storage-clone.ts` `clampWatermark`).
///
/// Here the bookmark reaches tag 5 before an undo back to the first read.
/// After it, a new 7,000-token read takes tag 5, and four small reads
/// follow: no newer person message and far less than a quarter of the
/// window of newer content, so tag 5 is not far behind.
///
/// Passes when the rebuild a lost cache gives (a ride) leaves tag 5 whole.
#[tokio::test]
async fn after_an_undo_a_new_output_under_the_old_bookmark_is_not_dropped_at_once() {
    let settings = Settings {
        keep_min_recovery_percentage: 0.0,
        ..Settings::default()
    };
    let mut runner = start_with(config("worker"), settings, None).await;
    // As the scenario suite's age-sweep test: reads at tags 3, 5, 7 and 9;
    // the passes over the threshold record 3 and 5 as far behind, then drop
    // 3 (5 stays in the protected tail).
    runner
        .play(&[
            user("Review the module."),
            read_file(),
            read_file(),
            read_file(),
            read_file(),
            answer(),
            answer(),
            answer(),
        ])
        .await;
    assert_eq!(
        seen(runner.host(), 3).as_deref(),
        Some(placeholder(3).as_str())
    );

    // The person undoes everything after the first read: tags 4 and up are
    // free again.
    let small_read = || {
        Step::Model(Turn {
            text: Some("Checking one more.".into()),
            tools: vec![ToolCall::ok(
                "read",
                json!({"path": "b.rs"}),
                "y".repeat(4_800),
            )],
            output_tokens: 10,
            ..Turn::default()
        })
    };
    runner
        .play(&[
            Step::Revert { ordinal: 3 },
            read_file(),
            small_read(),
            small_read(),
            small_read(),
            small_read(),
            // The cache expires: the runner rides, and the ride rebuilds.
            Step::Wait { ms: 300_001 },
            answer(),
        ])
        .await;
    let host = runner.host();
    // The ride rebuilds; with nothing else old enough to drop, it may hand
    // over no view at all, which also leaves tag 5 whole.
    assert!(
        !runner.report.rides.is_empty(),
        "precondition: the runner rode after the undo"
    );
    assert!(
        seen(host, 5).is_some_and(|text| text.starts_with("§5§ xxx")),
        "the new read at tag 5 went on the first rebuild after the undo: {:?}",
        seen(host, 5)
    );
}

// ---------------------------------------------------------------------------
// 7. An answered image whose result text quotes a tag number.
// ---------------------------------------------------------------------------

/// The answered-images lane replaces a tool result's `output` with its text
/// plus one `[image stripped]` line per image (spec 2 IM1). ck-mc checks
/// every view with the runner's functions over its own index, which holds
/// entries in compact form, without tool output (W4.8). The view library's
/// tag check allows a replaced field to carry only the part's own number
/// and the numbers its original text held, and with no original text it
/// allows only the part's own (`render.rs` `check_replaced_tags`: "With
/// compact tool output, this helper conservatively permits only the part's
/// own number"). So when the result's text quotes any tag (a screenshot of
/// this very conversation, a log line), ck-mc refuses its own view as
/// `foreign_tag`, throws the pass's work away and sets its parts aside.
/// The lane itself never consults the parts set aside, so it asks for the
/// same replace on every later pass whose drops reach the image: from the
/// first view that drops anything newer, no view lands again. The runner,
/// which reads replaced messages in full, would have accepted the view.
///
/// Passes when the screenshot's result loses its image and keeps its text,
/// as the plugin does, once newer content is dropped.
#[tokio::test]
async fn an_answered_image_whose_text_quotes_a_tag_still_goes() {
    let settings = Settings {
        keep_min_recovery_percentage: 0.0,
        ..Settings::default()
    };
    let mut runner = start_with(config("worker"), settings, None).await;
    let step = |text: &str, tools: Vec<ToolCall>| {
        Step::Model(Turn {
            text: Some(text.into()),
            tools,
            output_tokens: 10,
            ..Turn::default()
        })
    };
    runner
        .play(&[
            user("Look at the screen."),
            // Tags 2 and 3: a screenshot whose text quotes tag 1, answered
            // at tag 4.
            step(
                "Taking a screenshot.",
                vec![ToolCall::ok(
                    "screenshot",
                    json!({}),
                    "Screenshot of the review page, which quotes §1§.",
                )
                .with_images(1)],
            ),
            answer(),
            // Dropping tag 4 makes the screenshot old enough.
            reduce("4"),
            read_file(),
            read_file(),
            read_file(),
            read_file(),
        ])
        .await;
    for _ in 0..5 {
        if runner.host().applied_version().is_some() {
            break;
        }
        runner.play(&[answer()]).await;
    }
    let host = runner.host();
    let shown = host.rendered().iter().find_map(|message| {
        message
            .parts
            .iter()
            .find(|part| part.tag == Some(3))
            .and_then(|part| message.wire_text(part))
    });
    assert_eq!(
        shown.as_deref(),
        Some("§3§ Screenshot of the review page, which quotes §1§.\n[image stripped]"),
        "applied view {:?}, offered {:?}",
        host.applied_version(),
        runner.provider().client.offered.lock().unwrap()
    );
}
