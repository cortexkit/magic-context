//! `context.recent`: a session's newest messages as the summarizer's lines,
//! answered by the session's worker from the transcript index it holds. A
//! live session answers at once, a session with saved state but no worker is
//! restored by the read, an unknown one is refused, and one whose transcript
//! is still being read is asked to retry.

use super::*;
use crate::agent_data::Host;
use crate::client::{Child, ClientError, RunnerClient};
use crate::count::Counter;
use crate::module::Module;
use crate::route::Route;
use crate::routing::Router;
use crate::store::{Durable, Store};
use crate::summary::chunk;
use cortexkit_role_compaction::part::{Part, PartBody, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, NoticeOrigin, ReadPage, ReadRequest, Role, Select,
};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub(super) const PROVIDER: &str = "anthropic";
pub(super) const MODEL: &str = "claude-opus-5-5";
pub(super) const HARNESS: &str = "opencode2";

/// The transcript a runner serves, shared with the test that sets it.
#[derive(Default)]
pub(super) struct Transcript {
    pub entries: Mutex<Vec<Entry>>,
    /// Reads fail as a call does when the connection to the runner drops.
    pub fail: AtomicBool,
    pub reads: AtomicUsize,
}

#[derive(Clone, Default)]
pub(super) struct Runner(pub Arc<Transcript>);

impl RunnerClient for Runner {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        self.0.reads.fetch_add(1, Ordering::SeqCst);
        if self.0.fail.load(Ordering::SeqCst) {
            return Err(ClientError::new("connection lost"));
        }
        let entries = self.0.entries.lock().unwrap();
        let mut head = Head::new();
        head.newest = entries
            .last()
            .map(|entry| Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone()));
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
        _: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        Ok(ApplyViewAnswer::Accepted)
    }
    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        Ok(AppliedViewAnswer::default())
    }
    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("no sends in these tests"))
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("a worker preset runs no summarizer"))
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("a worker preset runs no summarizer"))
    }
}

impl Router for Runner {
    async fn select(
        &self,
        _: cortexkit_role_routing::select::SelectRequest,
    ) -> Result<cortexkit_role_routing::select::SelectAnswer, crate::routing::RouteError> {
        unreachable!("a worker preset routes no summarizer")
    }
    async fn report(&self, _: cortexkit_role_routing::report::ReportRequest) {}
}

pub(super) fn counter() -> Counter {
    Counter::for_model(Some(&format!("{PROVIDER}/{MODEL}")))
}

pub(super) fn text(text: &str) -> PartBody {
    PartBody::Text { text: text.into() }
}

pub(super) fn tool(call: &str, name: &str, input: Value) -> PartBody {
    PartBody::Tool(
        ToolPart::new(call, name, input, ToolStatus::Completed)
            .with_output("done")
            .with_output_bytes(4),
    )
}

pub(super) fn entry(ordinal: u64, role: Role, parts: Vec<PartBody>) -> Entry {
    let parts = parts
        .into_iter()
        .enumerate()
        .map(|(index, body)| {
            let mut part = Part::new(format!("p{ordinal}.{index}"), body);
            part.tag = Some(ordinal * 10 + index as u64);
            part
        })
        .collect();
    Entry::new(ordinal, format!("m{ordinal}"), role, ordinal, parts)
}

pub(super) fn notice(ordinal: u64, body: &str) -> Entry {
    entry(ordinal, Role::User, vec![text(body)]).with_notice(NoticeOrigin::new("prefrontal"))
}

/// A sentence of about `words` words, numbered so no two lines are alike.
pub(super) fn prose(label: &str, words: usize) -> String {
    let mut text = format!("{label}:");
    for word in 0..words {
        text.push_str(&format!(" step{word} parser"));
    }
    text
}

/// A session's messages: a request, the work on it with tool calls and a
/// commit, a hidden notice, and three long exchanges after it.
pub(super) fn transcript() -> Vec<Entry> {
    vec![
        entry(
            1,
            Role::User,
            vec![text("Please fix the parser bug in src/parse.rs.")],
        ),
        entry(2, Role::Assistant, vec![text("Looking at the parser now.")]),
        entry(
            3,
            Role::Assistant,
            vec![tool("c3", "read", json!({"filePath": "src/parse.rs"}))],
        ),
        entry(
            4,
            Role::Assistant,
            vec![tool(
                "c4",
                "bash",
                json!({"command": "cargo test", "description": "Run the parser tests"}),
            )],
        ),
        notice(5, "Inbox digest for the agent."),
        entry(
            6,
            Role::Assistant,
            vec![text(
                "Fixed the off-by-one and committed 1a2b3c4d5e with its test.",
            )],
        ),
        entry(7, Role::User, vec![text(&prose("Now explain the fix", 40))]),
        entry(8, Role::Assistant, vec![text(&prose("The fix", 60))]),
        entry(
            9,
            Role::User,
            vec![text(&prose("And the release notes", 50))],
        ),
        entry(
            10,
            Role::Assistant,
            vec![text(&prose("Release notes", 150))],
        ),
    ]
}

/// Each line `chunk::build` prints for `entries`, with the messages it
/// covers.
pub(super) fn lines(entries: &[Entry]) -> Vec<(u64, u64, String)> {
    let chunk = chunk::build(entries, u64::MAX, counter()).expect("lines");
    let mut lines = Vec::new();
    let mut from = chunk.input.find("\n\n").unwrap() + 2;
    for block in &chunk.printed_blocks {
        lines.push((
            block.start,
            block.end,
            chunk.input[from..block.text_end].to_owned(),
        ));
        from = block.text_end + 1;
    }
    lines
}

pub(super) fn joined(lines: &[(u64, u64, String)]) -> String {
    lines
        .iter()
        .map(|(_, _, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn request(method: &str, params: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"method": method, "params": params})).unwrap()
}

pub(super) fn recent_params(session: &str, budget: u64) -> Value {
    json!({"session": {"harness": HARNESS, "session": session}, "budget_tokens": budget})
}

pub(super) struct Fixture {
    _dir: tempfile::TempDir,
    pub runner: Runner,
    pub module: Module<Runner>,
}

impl Fixture {
    /// A module over a fresh context.db, where `session` has three
    /// summaries (messages 1-2, 3-4 and 5-6), and a fresh mode3.db, where
    /// each of `saved` has saved state.
    pub fn new(session: &str, saved: &[SessionRef]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
        db.with_connection(|conn| {
            conn.execute(
                "INSERT INTO session_meta(session_id,harness) VALUES(?1,?2)",
                params![session, HARNESS],
            )
            .unwrap();
            for (sequence, start, end, title) in [
                (0, 1, 2, "The parser bug"),
                (1, 3, 4, "Reading and testing the parser"),
                (2, 5, 6, "The off-by-one fix"),
            ] {
                conn.execute(
                    "INSERT INTO compartments(session_id,harness,sequence,start_message,end_message,title,content,p1,p2,p3,p4,importance,created_at) VALUES(?1,?2,?3,?4,?5,?6,'flat',?7,'short','anchor','tiny',50,0)",
                    params![session, HARNESS, sequence, start, end, title, format!("{title}: the full account.")],
                )
                .unwrap();
            }
        });
        let store = Store::open(&dir.path().join("mode3.db")).unwrap();
        for key in saved {
            store
                .save(
                    key,
                    &Durable {
                        compaction: Some((crate::preset::Features::NONE, conditions())),
                        preset: Some(crate::catalog::Preset::Worker.as_str().to_owned()),
                        ..Durable::default()
                    },
                )
                .unwrap();
        }
        let runner = Runner::default();
        *runner.0.entries.lock().unwrap() = transcript();
        let module = Module::new(
            runner.clone(),
            crate::pass::Settings::default(),
            Some(db),
            Some(store),
        );
        Self {
            _dir: dir,
            runner,
            module,
        }
    }

    /// Set `key` up as a worker on the test model, its runner stating the
    /// transcript's newest message, and wait until its worker has handled
    /// the Setup.
    pub async fn set_up(&self, key: &SessionRef) {
        let mut request = SetupRequest::new(
            crate::catalog::Preset::Worker.as_str(),
            ModelRef::new(PROVIDER, MODEL),
            200_000,
            1000,
            ProviderRules::new(SignedParts::None, EditCost::Suffix),
            Vec::new(),
            1,
        );
        request.newest = self
            .runner
            .0
            .entries
            .lock()
            .unwrap()
            .last()
            .map(|entry| Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone()));
        let route = Route {
            session: key.clone(),
            project: None,
            workdir: None,
            agent_id: None,
        };
        self.module.setup(route, request).unwrap();
        self.module.idle_foreground(key).await.unwrap();
    }

    pub async fn read(&self, method: &str, params: Value) -> Result<Value, Refusal> {
        self.module
            .context_read()
            .read(&request(method, params))
            .await
    }
}

pub(super) fn conditions() -> Conditions {
    Conditions::new(
        ModelRef::new(PROVIDER, MODEL),
        200_000,
        1000,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
    )
}

fn read_count(fixture: &Fixture) -> usize {
    fixture.runner.0.reads.load(Ordering::SeqCst)
}

#[tokio::test]
async fn person_facing_recent_reads_the_words_sent_through_say() {
    let fixture = Fixture::new("ses_live", &[]);
    fixture.runner.0.entries.lock().unwrap().extend([
        entry(11, Role::User, vec![text("Which path should I take?")]),
        entry(
            12,
            Role::Assistant,
            vec![
                tool(
                    "s12",
                    "say",
                    json!({"text":"Use the northern route.","reply_to":110}),
                ),
                text("sent"),
            ],
        ),
    ]);
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.set_up(&key).await;
    let answer = fixture
        .read("context.recent", recent_params("ses_live", 32_768))
        .await
        .unwrap();
    let text = answer["text"].as_str().unwrap();
    assert!(
        text.ends_with(
            "[11] U: Which path should I take?\n[12] A: (to §110§) Use the northern route."
        ),
        "{text}"
    );
    assert_eq!(answer["through_message"], 12);
}

#[tokio::test]
async fn recent_lines_are_the_summarizers_lines_for_the_newest_messages_within_budget() {
    let fixture = Fixture::new("ses_live", &[]);
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.set_up(&key).await;
    let entries = transcript();
    let all = lines(&entries);
    assert_eq!(
        all.iter()
            .map(|(from, to, _)| (*from, *to))
            .collect::<Vec<_>>(),
        [(1, 1), (2, 6), (7, 7), (8, 8), (9, 9), (10, 10)]
    );
    let counter = counter();
    // A budget the newest three lines fill exactly.
    let budget = counter.count(&joined(&all[3..]));
    assert!(budget > 256 && counter.count(&joined(&all[2..])) > budget);
    let answer = fixture
        .read("context.recent", recent_params("ses_live", budget))
        .await
        .unwrap();
    assert_eq!(answer["text"], joined(&all[3..]));
    assert_eq!(answer["from_message"], 8);
    assert_eq!(answer["through_message"], 10);
    assert_eq!(answer["tokens"], budget);
    assert_eq!(answer["summarized_through"], 6);
    assert_eq!(answer["token_family"], "ClaudeV5");
    assert_eq!(answer["exact"], true);
    assert!(answer.get("cut").is_none());
    // The lines are what the summarizer's chunk prints for those messages.
    let from = entries.iter().position(|entry| entry.ordinal == 8).unwrap();
    assert_eq!(answer["text"], joined(&lines(&entries[from..])));
    // A token less leaves the oldest of them out: lines are whole or absent.
    let answer = fixture
        .read("context.recent", recent_params("ses_live", budget - 1))
        .await
        .unwrap();
    assert_eq!(answer["text"], joined(&all[4..]));
    assert_eq!(answer["from_message"], 9);
    assert!(answer["tokens"].as_u64().unwrap() < budget);
    // The largest budget takes every line: the merged work, its commit and
    // its tool calls, with the hidden notice inside the line's range.
    let answer = fixture
        .read("context.recent", recent_params("ses_live", 32_768))
        .await
        .unwrap();
    let text = answer["text"].as_str().unwrap();
    assert_eq!(text, joined(&all));
    assert_eq!(answer["from_message"], 1);
    assert!(text.contains("\n[2-6] A: commits: 1a2b3c4d5e Looking at the parser now. / TC: read(src/parse.rs) / TC: Run the parser tests / "));
    assert!(!text.contains("Inbox digest"));
    assert_eq!(answer["tokens"], counter.count(text));
}

#[tokio::test]
async fn recent_cuts_a_newest_line_over_the_budget_to_its_header_and_its_end() {
    let fixture = Fixture::new("ses_live", &[]);
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.set_up(&key).await;
    let counter = counter();
    let newest = lines(&transcript()).pop().unwrap().2;
    assert!(counter.count(&newest) > 256);
    let answer = fixture
        .read("context.recent", recent_params("ses_live", 256))
        .await
        .unwrap();
    assert_eq!(answer["cut"], true);
    assert_eq!(answer["from_message"], 10);
    assert_eq!(answer["through_message"], 10);
    let text = answer["text"].as_str().unwrap();
    let kept = text.strip_prefix("[10] A: \u{2026} ").unwrap();
    assert!(!kept.is_empty() && newest.ends_with(kept));
    let tokens = answer["tokens"].as_u64().unwrap();
    assert_eq!(tokens, counter.count(text));
    assert!(tokens <= 256);
    // It keeps the longest end that fits: a character more goes over.
    let body = newest.strip_prefix("[10] A: ").unwrap();
    let longer = &body[body.len() - kept.len() - 1..];
    assert!(counter.count(&format!("[10] A: \u{2026} {longer}")) > 256);
}

#[test]
fn a_cut_line_drops_its_commit_list_only_when_the_full_header_leaves_no_room() {
    let entries = vec![
        entry(1, Role::User, vec![text("Land it.")]),
        entry(
            2,
            Role::Assistant,
            vec![text(&format!(
                "Committed 1a2b3c4d5e6f, 2b3c4d5e6f7a, 3c4d5e6f7a8b, 4d5e6f7a8b9c and 5e6f7a8b9c0d. {}",
                prose("Then", 80)
            ))],
        ),
    ];
    let counter = counter();
    let newest = lines(&entries).pop().unwrap().2;
    let full = "[2] A: commits: 1a2b3c4d5e6f, 2b3c4d5e6f7a, 3c4d5e6f7a8b, 4d5e6f7a8b9c, 5e6f7a8b9c0d \u{2026} ";
    let short = "[2] A: \u{2026} ";
    assert!(newest.starts_with(&full.replace("\u{2026} ", "")));
    // Room for the short header and a little text, not for the commit list.
    let budget = counter.count(short) + 4;
    assert!(counter.count(full) > budget);
    let cut = chunk::newest(&entries, budget, counter).unwrap();
    assert!(cut.cut);
    let kept = cut.text.strip_prefix(short).unwrap();
    assert!(!kept.is_empty() && newest.ends_with(kept));
    assert!(cut.tokens <= budget);
    assert_eq!((cut.from, cut.through), (2, 2));
    // With room for the full header, the commit list stays.
    let roomy = chunk::newest(&entries, counter.count(full) + 4, counter).unwrap();
    assert!(roomy.cut);
    let kept = roomy.text.strip_prefix(full).unwrap();
    assert!(!kept.is_empty() && newest.ends_with(kept));
}

#[test]
fn newest_lines_reach_past_the_first_window_for_a_long_line_and_for_many_short_ones() {
    let counter = counter();
    // A long run of tool calls merges into one line that starts 150
    // messages back, so the first windows start inside it.
    let mut entries = vec![entry(1, Role::User, vec![text("Refactor the parser.")])];
    for ordinal in 2..=151 {
        let path = format!("src/parser/f{ordinal}.rs");
        entries.push(entry(
            ordinal,
            Role::Assistant,
            vec![tool(
                &format!("c{ordinal}"),
                "read",
                json!({"filePath": path}),
            )],
        ));
    }
    let all = lines(&entries);
    assert_eq!(all.len(), 2);
    let every = chunk::newest(&entries, 32_768, counter).unwrap();
    assert_eq!(every.text, joined(&all));
    assert_eq!((every.from, every.through, every.cut), (1, 151, false));
    let only = chunk::newest(&entries, counter.count(&all[1].2), counter).unwrap();
    assert_eq!(only.text, all[1].2);
    assert_eq!((only.from, only.through, only.cut), (2, 151, false));
    // Hundreds of short lines: every one fits.
    let short: Vec<Entry> = (1..=300)
        .map(|ordinal| {
            let role = if ordinal % 2 == 1 {
                Role::User
            } else {
                Role::Assistant
            };
            entry(ordinal, role, vec![text(&format!("message {ordinal}"))])
        })
        .collect();
    let every = chunk::newest(&short, 32_768, counter).unwrap();
    assert_eq!(every.text, joined(&lines(&short)));
    assert_eq!(every.from, 1);
    assert_eq!(every.tokens, counter.count(&every.text));
    // Messages the summarizer would not print give no lines.
    assert_eq!(
        chunk::newest(&[notice(1, "Inbox digest.")], 1000, counter),
        None
    );
}

#[test]
fn newest_lines_never_pass_the_budget_and_are_whole_lines_unless_cut() {
    let counter = counter();
    let entries = transcript();
    let all = joined(&lines(&entries));
    for budget in (256..=1_200).step_by(37) {
        let newest = chunk::newest(&entries, budget, counter).unwrap();
        assert!(newest.tokens <= budget, "{budget}: {}", newest.tokens);
        assert_eq!(newest.tokens, counter.count(&newest.text));
        assert_eq!(newest.through, 10);
        if !newest.cut {
            assert!(all.ends_with(&newest.text));
            assert!(
                all.len() == newest.text.len()
                    || all[..all.len() - newest.text.len()].ends_with('\n')
            );
        }
    }
}

#[tokio::test]
async fn live_recent_reads_do_not_resolve_saved_runners() {
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    let fixture = Fixture::new("ses_live", &[]);
    fixture.set_up(&key).await;
    for _ in 0..3 {
        fixture
            .read("context.recent", recent_params("ses_live", 1000))
            .await
            .unwrap();
    }
    assert_eq!(
        fixture
            .module
            .context_read()
            .saved_lookups
            .load(Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn recent_restores_a_session_with_saved_state_and_reads_its_transcript_once() {
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_saved");
    let fixture = Fixture::new("ses_saved", std::slice::from_ref(&key));
    assert!(!fixture.module.active(&key));
    let answer = fixture
        .read("context.recent", recent_params("ses_saved", 32_768))
        .await
        .unwrap();
    // Its worker started, and restoring read the transcript.
    assert!(fixture.module.active(&key));
    let reads = read_count(&fixture);
    assert!(reads > 0);
    assert_eq!(answer["text"], joined(&lines(&transcript())));
    assert_eq!(answer["from_message"], 1);
    assert_eq!(answer["summarized_through"], 6);
    assert_eq!(answer["token_family"], "ClaudeV5");
    // Once restored, the worker answers from the index it holds.
    let again = fixture
        .read("context.recent", recent_params("ses_saved", 32_768))
        .await
        .unwrap();
    assert_eq!(again, answer);
    assert_eq!(read_count(&fixture), reads);
}

#[tokio::test]
async fn recent_asks_to_retry_while_the_transcript_is_not_read() {
    let transient = Some(json!({"class": "transient", "retry_after_ms": 2000}));
    // A live session whose Setup could not read its transcript.
    let fixture = Fixture::new("ses_live", &[]);
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.runner.0.fail.store(true, Ordering::SeqCst);
    fixture.set_up(&key).await;
    let refused = fixture
        .read("context.recent", recent_params("ses_live", 1000))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "transient");
    assert_eq!(refused.detail, transient);
}

#[tokio::test]
async fn recent_retries_a_saved_sessions_failed_transcript_read() {
    let saved = SessionRef::new("thalamus-harness", HARNESS, "ses_saved");
    let fixture = Fixture::new("ses_saved", std::slice::from_ref(&saved));
    fixture.runner.0.fail.store(true, Ordering::SeqCst);
    let refused = fixture
        .read("context.recent", recent_params("ses_saved", 1000))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "transient");
    assert_eq!(
        refused.detail,
        Some(json!({"class": "transient", "retry_after_ms": 2000}))
    );
    assert!(fixture.module.active(&saved));
    let reads = read_count(&fixture);
    fixture.runner.0.fail.store(false, Ordering::SeqCst);
    let answer = fixture
        .read("context.recent", recent_params("ses_saved", 32_768))
        .await
        .expect("a recovered runner can answer without another Setup or notice");
    assert_eq!(read_count(&fixture), reads + 1);
    assert_eq!(answer["text"], joined(&lines(&transcript())));
}

#[tokio::test]
async fn recent_refuses_a_session_with_neither_a_worker_nor_saved_state() {
    let fixture = Fixture::new("ses_live", &[]);
    let refused = fixture
        .read("context.recent", recent_params("ses_unknown", 1000))
        .await
        .unwrap_err();
    let summaries = fixture
        .read(
            "context.summaries",
            json!({"session": {"harness": HARNESS, "session": "ses_unknown"}, "budget_tokens": 1000}),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, "unknown_session");
    assert_eq!(refused, summaries);
    // Summaries in context.db hold no transcript: only a live worker or
    // saved state does.
    let refused = fixture
        .read("context.recent", recent_params("ses_live", 1000))
        .await
        .unwrap_err();
    assert_eq!(refused.code, "unknown_session");
    assert_eq!(read_count(&fixture), 0);
}

#[tokio::test]
async fn recent_takes_budgets_from_256_to_32768() {
    let fixture = Fixture::new("ses_live", &[]);
    let key = SessionRef::new("thalamus-harness", HARNESS, "ses_live");
    fixture.set_up(&key).await;
    for budget in [
        json!(0),
        json!(255),
        json!(32_769),
        json!(256.5),
        json!("300"),
        Value::Null,
    ] {
        let mut params = recent_params("ses_live", 0);
        params["budget_tokens"] = budget;
        let refused = fixture.read("context.recent", params).await.unwrap_err();
        assert_eq!(refused.code, "invalid_params");
        assert_eq!(refused.detail.unwrap()["field"], "budget_tokens");
    }
    for budget in [256, 32_768] {
        let answer = fixture
            .read("context.recent", recent_params("ses_live", budget))
            .await
            .unwrap();
        assert!(answer["tokens"].as_u64().unwrap() <= budget);
    }
    // The other reads keep their floor of one token.
    let answer = fixture
        .read(
            "context.summaries",
            json!({"session": {"harness": HARNESS, "session": "ses_live"}, "budget_tokens": 1}),
        )
        .await
        .unwrap();
    assert_eq!(answer["summaries"], json!([]));
}
