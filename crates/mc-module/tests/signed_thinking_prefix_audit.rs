//! Signed-thinking prefix audit for the Rust module transform: OpenCode 1 Rust mode
//! (`opencode-aisdk` profile, served through ck-mc) and Claude Code through ck-mc
//! (`claude-code-anthropic` profile).
//!
//! Same design as the TypeScript audit in
//! `packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts`: a
//! strict-binding provider mock answers every served request of a realistic Opus 5.5
//! tool loop, minting each thinking block's receipt from the request it accepted. One
//! mutation lane is then offered a cache-busting pass while the current turn holds
//! signed thinking (mid loop in a primary session, or anywhere in a subagent run), and
//! each primary lane has a control at a new user turn that must land the lane's own
//! edit validly.
//!
//! Findings: docs/reports/signed-thinking-prefix-edits-audit.md. Run with
//! `MC_AUDIT_STRICT=1` to make every exposed lane fail on its strict-binding 400.
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_module::config::CacheTtlProvenance;
use mc_module::transform::{transform, ProducerContext, TransformRequest, TransformResponse};
use mc_store::{McStore, StoredCompartment};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn golden() -> bool {
    std::env::var_os("MC_AUDIT_GOLDEN").is_some()
}

// Capture mode records every served request even when current-behavior or strict-binding assertions would fail.
macro_rules! audit_assert {
    ($($args:tt)*) => { if !golden() { assert!($($args)*); } };
}
macro_rules! audit_assert_eq {
    ($($args:tt)*) => { if !golden() { assert_eq!($($args)*); } };
}

const PREFIX_ERROR: &str = "bound to a different conversation";
const MIDDLE_ERROR: &str = "thinking removed from the middle";
const LATEST_TURN_ERROR: &str = "latest assistant turn thinking modified";
const BYTES_ERROR: &str = "thinking bytes modified";

/// One provider-visible block: `[role, kind]`.
type Block = Value;

/// A provider that answers like Anthropic with strict thinking binding: each thinking block it
/// returns is bound to the request it answered; a later request that changes anything before a
/// kept block, removes a kept block from the middle, removes current-turn thinking or alters a
/// block's bytes is rejected. Removing older thinking from the start of the history is allowed.
#[derive(Default)]
struct StrictMock {
    /// (thinking block, accepted request prefix, user turn)
    receipts: Vec<(Value, Vec<Block>, u64)>,
    turn: u64,
}

impl StrictMock {
    fn new_user_turn(&mut self) {
        self.turn += 1;
    }

    fn respond(&mut self, request: &[Block]) -> Value {
        if let Some(error) = self.check(request).filter(|_| !golden()) {
            panic!("the provider rejected a bootstrap request: {error}");
        }
        let n = self.receipts.len() + 1;
        let thinking = json!({"type":"reasoning","text":format!("Inspect the next file, then continue (step {n})."),"signature":format!("mock-signature-{n}")});
        self.receipts
            .push((thinking.clone(), request.to_vec(), self.turn));
        thinking
    }

    fn check(&self, request: &[Block]) -> Option<&'static str> {
        let sent: Vec<&Value> = request
            .iter()
            .filter(|b| b[1]["type"] == "reasoning")
            .map(|b| &b[1])
            .collect();
        for block in &sent {
            match self
                .receipts
                .iter()
                .find(|r| r.0["signature"] == block["signature"])
            {
                Some(receipt) if receipt.0 == **block => {}
                _ => return Some(BYTES_ERROR),
            }
        }
        let kept_signature =
            |r: &(Value, Vec<Block>, u64)| sent.iter().any(|b| b["signature"] == r.0["signature"]);
        let kept: Vec<usize> = self
            .receipts
            .iter()
            .enumerate()
            .filter(|(_, r)| kept_signature(r))
            .map(|(i, _)| i)
            .collect();
        if let (Some(first), Some(last)) = (kept.first(), kept.last()) {
            if last - first + 1 != kept.len() {
                return Some(MIDDLE_ERROR);
            }
        }
        if self
            .receipts
            .iter()
            .any(|r| r.2 == self.turn && !kept_signature(r))
        {
            return Some(LATEST_TURN_ERROR);
        }
        let removed: Vec<&Value> = self
            .receipts
            .iter()
            .filter(|r| !kept_signature(r))
            .map(|r| &r.0["signature"])
            .collect();
        let normalize = |blocks: &[Block]| -> Vec<Block> {
            blocks
                .iter()
                .filter(|b| !(b[1]["type"] == "reasoning" && removed.contains(&&b[1]["signature"])))
                .cloned()
                .collect()
        };
        for (index, block) in request.iter().enumerate() {
            if block[1]["type"] != "reasoning" {
                continue;
            }
            let receipt = self
                .receipts
                .iter()
                .find(|r| r.0["signature"] == block[1]["signature"])
                .unwrap();
            if normalize(&request[..index]) != normalize(&receipt.1) {
                return Some(PREFIX_ERROR);
            }
        }
        None
    }
}

/// The served request as the provider sees it: empty text sentinels and unsigned
/// reasoning are not sent, nor reasoning the host stripped (see `Fixture::observe`).
fn wire_with(response: &TransformResponse, host_stripped: &BTreeSet<String>) -> Vec<Block> {
    let messages = serde_json::to_value(response.messages()).unwrap();
    messages
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| {
            let stripped = m["meta"]["harness_id"]
                .as_str()
                .is_some_and(|mid| host_stripped.contains(mid));
            m["content"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|b| {
                    let kind = &b["kind"];
                    let empty_text = kind["type"] == "text"
                        && kind["text"].as_str().is_some_and(|t| t.trim().is_empty());
                    let reasoning = kind["type"] == "reasoning";
                    let unsent = reasoning && (kind["signature"].is_null() || stripped);
                    (!empty_text && !unsent).then(|| json!([m["role"], kind]))
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// First differing non-thinking block, for diagnosing an unexpected edit (MC_AUDIT_DEBUG=1).
fn debug_diff(label: &str, before: &[Block], after: &[Block]) {
    if std::env::var("MC_AUDIT_DEBUG").as_deref() != Ok("1") {
        return;
    }
    let (a, b) = (without_thinking(before), without_thinking(after));
    let short = |v: Option<&Value>| v.map(|v| v.to_string().chars().take(200).collect::<String>());
    let i = (0..a.len().max(b.len())).find(|&i| a.get(i) != b.get(i));
    if let Some(i) = i {
        println!(
            "DIFF {label} at={i} lens={}/{}\n  before: {:?}\n  after:  {:?}",
            a.len(),
            b.len(),
            short(a.get(i)),
            short(b.get(i))
        );
    }
}

fn without_thinking(blocks: &[Block]) -> Vec<Block> {
    blocks
        .iter()
        .filter(|b| b[1]["type"] != "reasoning")
        .cloned()
        .collect()
}

fn context() -> ProducerContext<'static> {
    ProducerContext {
        project_path: "git:signed-prefix-audit",
        note_project_path: "git:signed-prefix-audit",
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 60_000.0,
        memory_budget_tokens: 8_000.0,
        user_profile_budget_tokens: 4_000.0,
        memory_enabled: false,
        inject_docs: false,
        temporal_awareness: false,
        now_ms: 1_000,
        execute_threshold_percentage: 65.0,
        protected_tokens_floor: 4_000,
        protected_tokens_provenance: "config",
        compaction_enabled: true,
        smart_drops: false,
        protected_tools: Default::default(),
        cache_ttl: "5m".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
    }
}

fn message(mid: &str, ordinal: u64, role: &str, kinds: Vec<Value>) -> Value {
    json!({"mid":mid,"ordinal":ordinal,"ck":{"role":role,
        "content":kinds.into_iter().map(|kind| json!({"kind":kind})).collect::<Vec<_>>(),
        "meta":{"harness_id":mid}}})
}

fn read_call(id: &str, path: &str) -> Value {
    json!({"type":"tool_call","id":id,"name":"read","input":{"path":path},"provider_executed":false})
}

fn result(id: &str, tool: &str, text: &str) -> Value {
    json!({"type":"tool_result","id":id,"tool_name":tool,"output":{"kind":{"type":"text","text":text}},"provider_executed":false})
}

fn compartment(
    sequence: i64,
    start: i64,
    end: i64,
    start_mid: &str,
    end_mid: &str,
    title: &str,
) -> StoredCompartment {
    StoredCompartment {
        sequence,
        start_message: start,
        end_message: end,
        start_message_id: format!("{start_mid}#0"),
        end_message_id: format!("{end_mid}#0"),
        title: title.into(),
        content: format!("{title}: summarized."),
        p1: Some(format!("{title}: summarized.")),
        importance: 50,
        ..Default::default()
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lane {
    DropFull,
    Wall95,
    Flush,
    HardFold,
    /// A compartment rewrite (recomp promotion, boundary repair) with no bust offered: the next
    /// pass is an ordinary defer pass.
    Recomp,
    Todo,
    Caveman,
    Image,
    Placeholder,
}

const SUMMARY_TEXT: &str = "I have finished reading the parser and the lexer. The parser consumes tokens from the lexer, and the error recovery path is incomplete because it never resynchronises after an unexpected token.";
const COMPARTMENT_TITLE: &str = "Parser inspection";

/// See [`Fixture::triggers`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Triggers {
    soft_refresh_pending: bool,
    has_prior_emergency_drop: bool,
    pending_drops: usize,
}

struct Fixture {
    _dir: tempfile::TempDir,
    store: McStore,
    req: TransformRequest,
    ctx: ProducerContext<'static>,
    mock: StrictMock,
    served: TransformResponse,
    ordinal: u64,
    step: u64,
    lane: Lane,
    profile: String,
    /// Assistants whose reasoning the OpenCode Rust-mode host stripped (see `observe`).
    host_stripped: BTreeSet<String>,
    scenario: String,
    pass_number: u64,
}

impl Fixture {
    fn new(profile: &str, subagent: bool, lane: Lane, scenario: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "prefix-audit".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let req: TransformRequest = serde_json::from_value(json!({
            "serializer_profile": profile, "session_id": "prefix-audit", "render_config": "stable",
            "provider_id": "anthropic", "model_key": format!("anthropic/{}", std::env::var("MC_AUDIT_MODEL").unwrap_or_else(|_| "claude-opus-5-5".into())),
            "is_subagent": subagent, "tool_present": true, "todo_tool_present": true,
            "auto_search_enabled": false, "clear_reasoning_age": 1000,
            "keep_reasoning_tokens_effective": 1_000_000,
            "protected_tokens_effective": 4000, "protected_tags": 0, "protected_tags_present": true,
            "caveman_enabled": lane == Lane::Caveman, "caveman_min_chars": 40,
            "usage": {"current_total_input_tokens": 20_000, "context_limit_tokens": 100_000},
            "messages": []
        }))
        .unwrap();
        let ctx = context();
        let mut fixture = Fixture {
            served: transform(&store, &req, &ctx)
                .unwrap_or_else(|_| TransformResponse::need_full_sync(None)),
            _dir: dir,
            store,
            req,
            ctx,
            mock: StrictMock::default(),
            ordinal: 0,
            step: 0,
            lane,
            profile: profile.to_string(),
            host_stripped: BTreeSet::new(),
            scenario: scenario.into(),
            pass_number: 0,
        };
        fixture.build_history(subagent);
        fixture
    }

    fn push(&mut self, mid: &str, role: &str, kinds: Vec<Value>) {
        self.ordinal += 1;
        self.req
            .messages
            .push(serde_json::from_value(message(mid, self.ordinal, role, kinds)).unwrap());
    }

    fn pass(&mut self) -> TransformResponse {
        let response = transform(&self.store, &self.req, &self.ctx).unwrap();
        self.observe(&response);
        self.capture(&response);
        response
    }

    fn capture(&mut self, response: &TransformResponse) {
        let Some(root) = std::env::var_os("MC_AUDIT_GOLDEN") else {
            return;
        };
        self.pass_number += 1;
        let wire = wire_with(response, &self.host_stripped);
        let has_boundary = self.mock.receipts.iter().any(|r| {
            r.2 == self.mock.turn && wire.iter().any(|b| b[1]["signature"] == r.0["signature"])
        });
        let no_parked_trigger = self
            .store
            .load_meta(&self.req.session_id)
            .unwrap()
            .meta
            .held_release
            .is_none();
        let eligibility = json!({
            "defer": !response.prefix_bust_permitted, "noBoundary": !has_boundary,
            // validatingRecord is an eligibility flag for comparing captured request bytes,
            // not a validation result here. A saved request-prefix record would cover the
            // messages at the start, compaction summary and history-removal boundary.
            // This fixture never validates that record, so the flag is always true;
            // noParkedTrigger separately checks held_release for delayed triggers.
            "noParkedTrigger": no_parked_trigger, "validatingRecord": true,
        });
        let mode = if std::env::var("MC_AUDIT_STRICT").as_deref() == Ok("1") {
            "strict"
        } else {
            "default"
        };
        let dir = std::path::PathBuf::from(root)
            .join(&self.profile)
            .join(if self.req.is_subagent {
                "subagent"
            } else {
                "primary"
            })
            .join(&self.scenario)
            .join(format!("{:?}", self.lane));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("pass-{:04}.{mode}.json", self.pass_number));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        use std::io::Write;
        writeln!(file, "{}", json!({"wire": wire, "wireBytes": serde_json::to_string(&wire).unwrap(), "bustedThisPass": response.prefix_bust_permitted,
            "identityEligible": !response.prefix_bust_permitted && !has_boundary && no_parked_trigger,
            "eligibility": eligibility})).unwrap();
    }

    fn wire(&self) -> Vec<Block> {
        wire_with(&self.served, &self.host_stripped)
    }

    /// Model the OpenCode Rust-mode host postprocess (`applyRustModeThinkingStrips` in
    /// transform-postprocess-phase.ts): on a module bust while the current turn holds no
    /// thinking, it freezes and strips every reasoning-bearing assistant, and replays that
    /// strip on every later pass. During an active thinking turn it strips nothing. The
    /// Claude Code profile has no such host step in this repository, so nothing is
    /// stripped there.
    fn observe(&mut self, response: &TransformResponse) {
        if self.profile != "opencode-aisdk" || !response.prefix_bust_permitted {
            return;
        }
        let last_user = self.req.messages.iter().rposition(|m| m.ck.role == "user");
        let active_thinking = self.req.messages[last_user.map_or(0, |i| i + 1)..]
            .iter()
            .any(|m| {
                m.ck.role == "assistant"
                    && serde_json::to_string(&m.ck.content)
                        .unwrap()
                        .contains("\"reasoning\"")
            });
        if active_thinking {
            return;
        }
        let served = serde_json::to_value(response.messages()).unwrap();
        for m in served.as_array().unwrap() {
            if m["role"] == "assistant" && m["content"].to_string().contains("\"reasoning\"") {
                if let Some(mid) = m["meta"]["harness_id"].as_str() {
                    self.host_stripped.insert(mid.to_string());
                }
            }
        }
    }

    fn user_turn(&mut self, mid: &str, text: &str, extra: Vec<Value>) {
        self.mock.new_user_turn();
        let mut kinds = vec![json!({"type":"text","text":text})];
        kinds.extend(extra);
        self.push(mid, "user", kinds);
    }

    /// Answer the served request with one assistant step and its tool results.
    fn respond(&mut self, blocks: Vec<Value>, results: Vec<Value>, with_thinking: bool) {
        let request = self.wire();
        let thinking = if with_thinking && self.scenario != "force-latch-no-thinking" {
            Some(self.mock.respond(&request))
        } else {
            if let Some(error) = self.mock.check(&request).filter(|_| !golden()) {
                panic!("the provider rejected a bootstrap request: {error}");
            }
            None
        };
        self.step += 1;
        let mid = format!("step-{}", self.step);
        let mut kinds: Vec<Value> = thinking.into_iter().collect();
        kinds.extend(blocks);
        self.push(&mid, "assistant", kinds);
        for (i, result) in results.into_iter().enumerate() {
            self.push(&format!("{mid}-result-{i}"), "tool", vec![result]);
        }
        self.served = self.pass();
    }

    fn build_history(&mut self, subagent: bool) {
        let image = if self.lane == Lane::Image {
            vec![
                json!({"type":"media","kind":"image","media_type":"image/png","source":{"type":"data_base64","data":"iVBORw0KGgo".repeat(40)}}),
            ]
        } else {
            vec![]
        };
        // A realistic Rust-mode session already holds a compartment (a historian
        // summary of earlier messages). Without one the module never schedules the
        // SOFT pass that applies reductions, so no lane could land at all.
        self.push(
            "seed-user",
            "user",
            vec![json!({"type":"text","text":"Set up the parser project."})],
        );
        self.push(
            "seed-assistant",
            "assistant",
            vec![json!({"type":"text","text":"The parser project is set up."})],
        );
        self.store
            .replace_compartments(
                &self.req.session_id.clone(),
                &[compartment(
                    0,
                    1,
                    2,
                    "seed-user",
                    "seed-assistant",
                    "Project setup",
                )],
            )
            .unwrap();
        self.served = self.pass();
        self.user_turn(
            "prompt-1",
            "Inspect the parser and the attached screenshot, then report.",
            image,
        );
        self.served = self.pass();
        let parser = "export function parse(tokens) { /* recursive descent */ }\n".repeat(150);
        self.respond(
            vec![read_call("old-read-a", "/project/src/parser.ts")],
            vec![result("old-read-a", "read", &parser)],
            true,
        );
        self.respond(
            vec![read_call("old-read-b", "/project/src/ast.ts")],
            vec![result(
                "old-read-b",
                "read",
                &"export interface Node { kind: string }\n".repeat(150),
            )],
            false,
        );
        self.respond(
            vec![read_call("old-read-c", "/project/src/lexer.ts")],
            vec![result(
                "old-read-c",
                "read",
                &"export function lex(src) {}\n".repeat(150),
            )],
            true,
        );
        self.respond(
            vec![json!({"type":"text","text":SUMMARY_TEXT})],
            vec![],
            true,
        );
        if self.lane == Lane::Placeholder {
            self.push(
                "placeholder-only",
                "assistant",
                vec![json!({"type":"text","text":"[dropped §998§]"})],
            );
            self.served = self.pass();
        }
        if !subagent {
            audit_assert_eq!(self.mock.check(&self.wire()), None);
            self.user_turn(
                "prompt-2",
                "Now repair the error recovery in the parser; keep using tools until it is done.",
                vec![],
            );
            self.served = self.pass();
        }
    }

    fn tool_loop(&mut self, steps: usize) -> Vec<Block> {
        for _ in 0..steps {
            let n = self.step + 1;
            let id = format!("call-{n}");
            self.respond(
                vec![read_call(&id, &format!("/project/src/file-{n}.ts"))],
                vec![result(
                    &id,
                    "read",
                    &format!("export const v{n} = {n};\n").repeat(400),
                )],
                true,
            );
            audit_assert_eq!(self.mock.check(&self.wire()), None, "loop step {n}");
            if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
                let bust = self.served.prefix_bust_permitted;
                println!("META loop step {n}: bust={bust} {:?}", self.triggers());
            }
        }
        self.wire()
    }

    fn next_user_turn(&mut self, mid: &str) {
        let text = format!(
            "Step {}: this part of the work is done and verified.",
            self.step + 1
        );
        self.respond(vec![json!({"type":"text","text":text})], vec![], true);
        audit_assert_eq!(self.mock.check(&self.wire()), None);
        self.user_turn(
            mid,
            "Continue with the next part of the parser work; keep using tools until done.",
            vec![],
        );
        self.served = self.pass();
        audit_assert_eq!(self.mock.check(&self.wire()), None);
    }

    fn set_usage(&mut self, tokens: u64) {
        self.req.usage = serde_json::from_value(
            json!({"current_total_input_tokens":tokens,"context_limit_tokens":100_000}),
        )
        .unwrap();
    }

    /// The persisted triggers that offer a bust: the armed `/ctx-flush` refresh, the
    /// force-band episode latch and the queued agent drops. A held pass must leave them as it
    /// found them, so the work it declined is offered again at the next user turn.
    fn triggers(&self) -> Triggers {
        let meta = self.store.load_meta(&self.req.session_id).unwrap().meta;
        Triggers {
            soft_refresh_pending: meta.soft_refresh_pending,
            has_prior_emergency_drop: meta.has_prior_emergency_drop,
            pending_drops: self
                .store
                .load_pending_agent_drops(&self.req.session_id)
                .unwrap()
                .len(),
        }
    }

    fn todo(&self, state: &str, anchor: &str) {
        self.store
            .set_todo_state(&self.req.session_id, state, anchor, "audit")
            .unwrap();
    }

    /// Lane setup that exists in a real session before the later bust.
    fn prepare(&mut self) {
        if self.lane == Lane::Todo {
            self.todo(
                r#"[{"content":"Inspect parser","status":"in_progress","priority":"high"}]"#,
                "prompt-2",
            );
            self.store.arm_soft_refresh(&self.req.session_id).unwrap();
            self.served = self.pass();
            audit_assert_eq!(self.mock.check(&self.wire()), None);
        }
    }

    fn arm_and_bust(&mut self, subagent: bool) {
        let sid = self.req.session_id.clone();
        match self.lane {
            // An answered image is stripped once its tag is at or below the highest
            // dropped tag number. The module computes that number after this pass's
            // drops, so the image is stripped on the same pass as a drop.
            Lane::DropFull | Lane::Flush | Lane::Image => {
                self.store.append_pending_agent_drops(&sid, &["step-2-result-0#0".into()], 1).unwrap();
            }
            Lane::HardFold | Lane::Recomp => {
                // The historian published a compartment covering the first turn.
                let end = self.req.messages.iter().find(|m| m.mid == "step-4").unwrap().ordinal as i64;
                self.store
                    .replace_compartments(
                        &sid,
                        &[
                            compartment(0, 1, 2, "seed-user", "seed-assistant", "Project setup"),
                            compartment(1, 3, end, "prompt-1", "step-4", COMPARTMENT_TITLE),
                        ],
                    )
                    .unwrap();
            }
            Lane::Todo => self.todo(
                r#"[{"content":"Inspect parser","status":"completed","priority":"high"},{"content":"Repair error recovery","status":"in_progress","priority":"high"}]"#,
                &format!("step-{}", self.step),
            ),
            _ => {}
        }
        if self.lane == Lane::Flush {
            self.store.arm_soft_refresh(&sid).unwrap();
            return;
        }
        if self.lane == Lane::Recomp {
            return;
        }
        self.set_usage(match (self.lane, subagent) {
            (Lane::Wall95, _) => 95_000,
            (_, true) => 76_000,
            _ => 85_000,
        });
    }

    fn landed(&self, before: &[Block], after: &[Block]) -> bool {
        let text = serde_json::to_string(after).unwrap();
        let pending = self
            .store
            .load_pending_agent_drops(&self.req.session_id)
            .unwrap()
            .len();
        match self.lane {
            Lane::DropFull | Lane::Flush => pending == 0,
            Lane::Wall95 => without_thinking(before) != without_thinking(after),
            Lane::HardFold | Lane::Recomp => text.contains(COMPARTMENT_TITLE),
            Lane::Todo => text.contains("Repair error recovery"),
            Lane::Caveman => !text.contains(SUMMARY_TEXT),
            Lane::Image => !text.contains("\"media\""),
            Lane::Placeholder => !text.contains("[dropped §998§]"),
        }
    }
}

/// Lanes whose mid-loop bust changes the request before a signed thinking block the request
/// still carries, which a strict-binding provider rejects.
fn exposed(subagent: bool, lane: Lane) -> bool {
    !subagent && matches!(lane, Lane::HardFold | Lane::Todo | Lane::Placeholder)
}

fn mid_loop(profile: &str, subagent: bool, lane: Lane) {
    let mut f = Fixture::new(profile, subagent, lane, "mid-loop");
    f.prepare();
    let before = f.tool_loop(4);
    f.arm_and_bust(subagent);
    let armed = f.triggers();
    if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
        println!("META armed {lane:?} subagent={subagent}: {armed:?}");
    }
    f.served = f.pass();
    let after = f.wire();
    let error = f.mock.check(&after);
    let landed = f.landed(&before, &after);
    let non_thinking_edit = without_thinking(&before) != without_thinking(&after);
    debug_diff(
        &format!("{profile} subagent={subagent} {lane:?}"),
        &before,
        &after,
    );
    if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
        let meta = serde_json::to_value(&f.served).unwrap();
        println!(
            "META mid-loop {lane:?} subagent={subagent}: action={} materialize={} bust={} {:?}",
            meta["action"],
            meta["materialize_reason"],
            meta["prefix_bust_permitted"],
            f.triggers()
        );
    }
    println!("AUDIT {profile} | subagent={subagent} | {lane:?}: {error:?}; laneLanded={landed}; nonThinkingEdit={non_thinking_edit}");
    // Under MC_AUDIT_STRICT=1 every lane must behave as held, which is the acceptance bar of
    // docs/designs/signed-thinking-hold.md.
    let strict = std::env::var("MC_AUDIT_STRICT").as_deref() == Ok("1");
    if !golden() && !strict && exposed(subagent, lane) {
        audit_assert!(
            landed,
            "{profile} subagent={subagent} {lane:?}: the lane did not land"
        );
        audit_assert_eq!(
            error,
            Some(PREFIX_ERROR),
            "{profile} subagent={subagent} {lane:?}"
        );
        return;
    }
    audit_assert_eq!(error, None, "{profile} subagent={subagent} {lane:?}");
    audit_assert!(
        !non_thinking_edit,
        "{profile} subagent={subagent} {lane:?}: held lane changed bytes"
    );
    audit_assert!(
        !landed,
        "{profile} subagent={subagent} {lane:?}: held lane landed"
    );
    if profile == "opencode-aisdk"
        && matches!(
            lane,
            Lane::DropFull | Lane::Flush | Lane::Caveman | Lane::Image
        )
    {
        audit_assert!(
            !f.served.prefix_bust_permitted,
            "{profile} {lane:?}: an all-held pass priced a cache bust"
        );
    }
    // A held edit is never recorded as served: repeating the pass with no new response serves
    // exactly the same bytes.
    f.served = f.pass();
    audit_assert_eq!(
        f.wire(),
        after,
        "{profile} subagent={subagent} {lane:?}: a repeat pass changed the held bytes"
    );
    f.tool_loop(2);
    if subagent {
        return;
    }
    // On Claude Code every bust at a new user turn is rejected today because older-turn thinking
    // is kept (see `control`), so the release check runs there only in strict mode.
    if !golden() && !strict && profile == "claude-code-anthropic" {
        return;
    }
    // A compartment rewrite with no ride is never rendered by the module, mid loop or at a new
    // user turn, so there is nothing to release (see `control`).
    if !golden() && lane == Lane::Recomp {
        return;
    }
    // The held edit is released, not lost: once a real user message starts the next turn, the
    // same state (still armed, nothing re-queued) lands the lane's edit validly.
    // The held pass and the passes after it in the same turn applied nothing, so they must not
    // spend the trigger that offered the work: the armed refresh stays armed, the force episode
    // stays available and the queued drops stay queued.
    let held = f.triggers();
    if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
        println!("META before release {lane:?}: {held:?}");
    }
    if !golden() {
        audit_assert_eq!(
            held,
            armed,
            "{profile} {lane:?}: a held pass spent the trigger that offered its work"
        );
    }
    let before_release = f.wire();
    f.next_user_turn("prompt-release");
    let released = f.wire();
    if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
        let meta = serde_json::to_value(&f.served).unwrap();
        println!(
            "META release {lane:?}: action={} materialize={} bust={} {:?}",
            meta["action"],
            meta["materialize_reason"],
            meta["prefix_bust_permitted"],
            f.triggers()
        );
    }
    let released_landed = f.landed(&before_release, &released);
    println!(
        "AUDIT-RELEASE {profile} | next user turn | {lane:?}: {:?}; laneLanded={released_landed}",
        f.mock.check(&released),
    );
    audit_assert_eq!(f.mock.check(&released), None, "{profile} {lane:?} release");
    // The 95% wall's landing predicate compares non-thinking bytes, which a new turn always
    // changes, so it cannot show a release; its validity above is still checked.
    if lane == Lane::Wall95 {
        return;
    }
    audit_assert!(
        released_landed,
        "{profile} {lane:?}: the held edit did not land at the next user turn"
    );
}

fn control(profile: &str, lane: Lane) {
    // A compartment rewrite with no ride is not rendered at a new user turn either; the lane is
    // only a defer byte-identity check mid loop.
    if !golden() && lane == Lane::Recomp {
        return;
    }
    let mut f = Fixture::new(profile, false, lane, "control");
    f.prepare();
    f.tool_loop(4);
    f.next_user_turn("prompt-next");
    let before = f.wire();
    f.arm_and_bust(false);
    f.served = f.pass();
    let after = f.wire();
    let error = f.mock.check(&after);
    let landed = f.landed(&before, &after);
    debug_diff(&format!("control {profile} {lane:?}"), &before, &after);
    if std::env::var("MC_AUDIT_DEBUG").as_deref() == Ok("1") {
        let meta = serde_json::to_value(&f.served).unwrap();
        println!("META control {lane:?}: action={} decision={} scheduler={} defer={} materialize={} bust={} pending={}", meta["action"], meta["decision"], meta["scheduler_decision"], meta["scheduler_defer_reason"], meta["materialize_reason"], meta["prefix_bust_permitted"], f.store.load_pending_agent_drops(&f.req.session_id).unwrap().len());
    }
    println!("AUDIT-CONTROL {profile} | new user turn | {lane:?}: {error:?}; laneLanded={landed}");
    audit_assert!(
        landed,
        "{profile} {lane:?}: the control did not land the lane's edit"
    );
    if !golden()
        && std::env::var("MC_AUDIT_STRICT").as_deref() != Ok("1")
        && profile == "claude-code-anthropic"
    {
        // The module keeps every older signed thinking block on a Claude Code bust:
        // the profile has no binding strip (reasoning_clear_cutoff_with_tags returns
        // None for prefix-bound models) and this repository has no Claude Code host
        // step that strips it. Whether the Claude Code client replays earlier-turn
        // thinking at all is for the gateway owner to confirm.
        audit_assert_eq!(error, Some(PREFIX_ERROR), "{profile} {lane:?}");
        return;
    }
    audit_assert_eq!(error, None, "{profile} {lane:?}");
    f.tool_loop(3);
}

// Lanes whose control lands its own edit in this fixture. Skeleton drops, dedup and
// supersession, the 85% force band, reasoning clearing and the stale ctx_reduce strip
// did not price a bust or select work here even at a new user turn, so a held result
// for them would be vacuous; the report covers them from the code.
const PRIMARY_LANES: [Lane; 9] = [
    Lane::DropFull,
    Lane::Wall95,
    Lane::Flush,
    Lane::HardFold,
    Lane::Recomp,
    Lane::Todo,
    Lane::Caveman,
    Lane::Image,
    Lane::Placeholder,
];
// A subagent pass at the execute threshold is already allowed to change the request
// (the module reports a SOFT `m1_delta` pass), so a held result here is the thinking
// guard declining the edit, not a missing permission.
const SUBAGENT_LANES: [Lane; 3] = [Lane::DropFull, Lane::Wall95, Lane::Placeholder];

/// `MC_AUDIT_LANE=<Lane>` restricts a diagnostic run to one lane.
fn selected(lane: Lane) -> bool {
    std::env::var("MC_AUDIT_LANE").map_or(true, |only| only == format!("{lane:?}"))
}

macro_rules! audit {
    ($name:ident, $profile:literal) => {
        mod $name {
            use super::*;
            #[test]
            fn primary_mid_loop() {
                for lane in PRIMARY_LANES.into_iter().filter(|l| selected(*l)) {
                    mid_loop($profile, false, lane);
                }
            }
            #[test]
            fn subagent_run() {
                for lane in SUBAGENT_LANES.into_iter().filter(|l| selected(*l)) {
                    mid_loop($profile, true, lane);
                }
            }
            #[test]
            fn control_at_new_user_turn() {
                for lane in PRIMARY_LANES.into_iter().filter(|l| selected(*l)) {
                    control($profile, lane);
                }
            }
        }
    };
}

audit!(opencode_rust_mode, "opencode-aisdk");
audit!(claude_code, "claude-code-anthropic");

#[test]
fn force_latch_ignores_bookkeeping_without_thinking() {
    let mut f = Fixture::new(
        "opencode-aisdk",
        false,
        Lane::DropFull,
        "force-latch-no-thinking",
    );
    // Set the protection count above the request size so no request content can be
    // shortened or dropped. Trailing-blank bookkeeping must not consume the one
    // rewrite opportunity offered when usage reaches the force band.
    f.req.protected_tokens_effective = Some(1_000_000_000);
    f.served = f.pass();
    let before = f.store.load(&f.req.session_id).unwrap().core;
    f.set_usage(85_000);
    f.tool_loop(2);
    let loaded = f.store.load(&f.req.session_id).unwrap();
    assert!(
        !loaded.meta.has_prior_emergency_drop,
        "bookkeeping spent the force episode without reclaim"
    );
    let added: Vec<_> = loaded
        .core
        .frozen_units
        .iter()
        .filter(|unit| !before.frozen_units.iter().any(|old| old.key == unit.key))
        .collect();
    assert!(
        added
            .iter()
            .any(|unit| unit.key.starts_with("strip:trailing_blank_")),
        "the control must reach trailing-blank bookkeeping"
    );
    assert!(
        added
            .iter()
            .all(|unit| unit.key.starts_with("strip:trailing_blank_")),
        "the control unexpectedly applied real reclaim: {added:?}"
    );
    assert!(
        f.mock.receipts.is_empty(),
        "the differential control must have no thinking turn"
    );
}

#[test]
fn held_flush_keeps_commit_state() {
    let mut f = Fixture::new("opencode-aisdk", false, Lane::Flush, "held-flush-commit");
    f.tool_loop(4);
    f.arm_and_bust(false);
    let mut snapshot = f.store.load_meta(&f.req.session_id).unwrap();
    snapshot.meta.decision_calibration = None;
    snapshot.meta.guidance_date = "2026-09-01".into();
    snapshot
        .meta
        .pending_tag_block_ids
        .insert("step-1#0".into());
    snapshot
        .meta
        .pending_user_hint_block_ids
        .insert("step-1#0".into());
    f.store
        .commit_meta(&f.req.session_id, snapshot.row_version, &snapshot.meta)
        .unwrap();
    f.ctx.guidance_date = Some("2026-09-02".into());
    f.req.protected_tokens_effective = Some(8_000);
    let before = f.wire();
    f.served = f.pass();
    let after = f.store.load_meta(&f.req.session_id).unwrap().meta;
    audit_assert_eq!(f.wire(), before);
    audit_assert!(!f.served.prefix_bust_permitted);
    audit_assert_eq!(f.mock.check(&f.wire()), None);
    audit_assert!(after.soft_refresh_pending);
    audit_assert_eq!(
        after.decision_calibration,
        snapshot.meta.decision_calibration
    );
    audit_assert_eq!(after.guidance_date, snapshot.meta.guidance_date);
    audit_assert_eq!(
        after.protected_tokens_effective,
        snapshot.meta.protected_tokens_effective
    );
    audit_assert_eq!(
        after.last_execute_ordinal,
        snapshot.meta.last_execute_ordinal
    );
    audit_assert_eq!(
        after.pending_tag_block_ids,
        snapshot.meta.pending_tag_block_ids
    );
    audit_assert_eq!(
        after.pending_user_hint_block_ids,
        snapshot.meta.pending_user_hint_block_ids
    );
    audit_assert_eq!(
        after.held_release.as_ref().unwrap()["obligations"]["soft_refresh"],
        "explicit_flush"
    );
}

#[test]
fn parked_force_and_flush_are_not_standing_permissions() {
    for lane in [Lane::DropFull, Lane::Flush] {
        let mut f = Fixture::new("opencode-aisdk", false, lane, "trigger-parking");
        f.req.protected_tokens_effective = Some(0);
        f.ctx.protected_tokens_floor = 0;
        f.user_turn("parking-setup", "Begin a new tool loop.", vec![]);
        f.store.arm_soft_refresh(&f.req.session_id).unwrap();
        f.served = f.pass();
        f.tool_loop(4);
        f.arm_and_bust(false);
        f.served = f.pass();
        audit_assert!(
            !f.served.prefix_bust_permitted,
            "{lane:?}: all-held pass must defer"
        );
        audit_assert!(f
            .store
            .load_meta(&f.req.session_id)
            .unwrap()
            .meta
            .held_release
            .is_some());
        // The fixture requests a zero-token protection floor; selection still protects
        // the three newest tool tags. All new call/result pairs follow kept thinking,
        // and three newer pairs make the first result eligible for the queued drop.
        // The earlier held force episode or flush must not authorize dropping that
        // result in this same turn.
        let tail_step = f.step + 1;
        for suffix in ["tail", "window-1", "window-2", "window-3"] {
            let id = format!("parking-{suffix}");
            f.respond(
                vec![read_call(&id, &format!("/project/{suffix}.ts"))],
                vec![result(&id, "read", &"const parking = true;\n".repeat(400))],
                false,
            );
            audit_assert!(
                !f.served.prefix_bust_permitted,
                "{lane:?}: parked trigger authorized tail growth"
            );
        }
        f.store
            .append_pending_agent_drops(
                &f.req.session_id,
                &[format!("step-{tail_step}-result-0#0")],
                2,
            )
            .unwrap();
        if lane == Lane::Flush {
            f.store.arm_soft_refresh(&f.req.session_id).unwrap();
        }
        let before = f.wire();
        f.served = f.pass();
        audit_assert_eq!(
            f.wire(),
            before,
            "{lane:?}: parked permission landed a tail edit"
        );
        audit_assert!(!f.served.prefix_bust_permitted);
        audit_assert_eq!(
            f.store
                .load_pending_agent_drops(&f.req.session_id)
                .unwrap()
                .len(),
            2
        );
        f.next_user_turn("parking-release");
        audit_assert!(f.served.prefix_bust_permitted);
        audit_assert_eq!(f.mock.check(&f.wire()), None);
        let pending = f.store.load_pending_agent_drops(&f.req.session_id).unwrap();
        audit_assert_eq!(
            pending.len(),
            0,
            "{lane:?}: release left {pending:?}; reason={:?}",
            f.served.materialize_reason
        );
        audit_assert!(f
            .store
            .load_meta(&f.req.session_id)
            .unwrap()
            .meta
            .held_release
            .is_none());
        if lane == Lane::Flush {
            f.served = f.pass();
            audit_assert!(
                !f.served.prefix_bust_permitted,
                "flush release must bust only once"
            );
        }
    }
}

#[test]
fn claude_code_held_flush_retains_legacy_profile_gate() {
    let mut f = Fixture::new(
        "claude-code-anthropic",
        false,
        Lane::Flush,
        "flush-profile-gate",
    );
    f.tool_loop(4);
    f.arm_and_bust(false);
    f.served = f.pass();
    audit_assert!(f.served.prefix_bust_permitted);
    let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
    audit_assert!(!meta.soft_refresh_pending);
    audit_assert!(meta.held_release.is_none());
}

#[test]
fn step2_review_claude_code_gate_preserves_guidance_adoption() {
    let mut f = Fixture::new(
        "claude-code-anthropic",
        false,
        Lane::Flush,
        "review-guidance-gate",
    );
    f.tool_loop(4);
    f.arm_and_bust(false);
    f.ctx.guidance_date = Some("2026-09-02".into());
    f.served = f.pass();
    let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
    assert!(f.served.prefix_bust_permitted);
    assert!(!meta.soft_refresh_pending);
    assert!(meta.held_release.is_none());
    // Planned Claude Code behavior keeps a blocked flush pending until a pass can
    // rewrite the prefix without current-turn thinking. Rollout step 8 in
    // docs/designs/signed-thinking-hold.md also removes completed-turn thinking so
    // that release does not resend invalidated old signatures. Until then, preserve
    // the existing flush: adopt the next system-prompt date and consume the refresh
    // flag without parking it.
    assert_eq!(
        meta.guidance_date, "2026-09-02",
        "Claude Code guidance behavior changed despite the profile gate"
    );
}

#[test]
fn step2_review_claude_code_gate_preserves_pending_overlay_drain() {
    let mut f = Fixture::new(
        "claude-code-anthropic",
        false,
        Lane::Flush,
        "review-overlay-gate",
    );
    f.tool_loop(4);
    f.arm_and_bust(false);
    let mut snapshot = f.store.load_meta(&f.req.session_id).unwrap();
    snapshot
        .meta
        .pending_tag_block_ids
        .insert("step-1#0".into());
    snapshot
        .meta
        .pending_user_hint_block_ids
        .insert("step-1#0".into());
    f.store
        .commit_meta(&f.req.session_id, snapshot.row_version, &snapshot.meta)
        .unwrap();
    f.req.auto_search_enabled = true;
    f.served = f.pass();
    let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
    assert!(f.served.prefix_bust_permitted);
    assert!(!meta.soft_refresh_pending);
    assert!(meta.held_release.is_none());
    // Planned behavior keeps pending tag/hint IDs while their blocks cannot safely
    // change under kept current-turn thinking. Rollout step 8 in
    // docs/designs/signed-thinking-hold.md adds that delay for Claude Code and removes
    // completed-turn thinking before release. Until then, preserve the existing
    // behavior: clear pending_tag_block_ids and pending_user_hint_block_ids on
    // mutation passes so tags/hints can render, while a flush consumes its refresh flag.
    assert!(
        meta.pending_tag_block_ids.is_empty() && meta.pending_user_hint_block_ids.is_empty(),
        "Claude Code pending overlays changed despite the profile gate: tags={:?}, hints={:?}",
        meta.pending_tag_block_ids,
        meta.pending_user_hint_block_ids
    );
}

#[test]
fn step2_review_parked_lanes_replay_and_release_after_store_reopen() {
    for lane in [Lane::DropFull, Lane::Flush, Lane::Caveman, Lane::Image] {
        let mut f = Fixture::new("opencode-aisdk", false, lane, "review-reopen");
        f.tool_loop(4);
        f.arm_and_bust(false);
        let before = f.wire();
        f.served = f.pass();
        assert_eq!(f.wire(), before, "{lane:?}: held pass changed bytes");
        assert!(!f.served.prefix_bust_permitted);
        assert!(f
            .store
            .load_meta(&f.req.session_id)
            .unwrap()
            .meta
            .held_release
            .is_some());
        for _ in 0..3 {
            f.served = f.pass();
            assert_eq!(
                f.wire(),
                before,
                "{lane:?}: pass without a new user changed bytes"
            );
            assert!(!f.served.prefix_bust_permitted);
        }
        f.tool_loop(3);
        let before_reopen = f.wire();
        // Close and reopen the on-disk store without re-queuing work. The original held
        // triggers must survive that database reopen, even with a fresh cache namespace.
        // This tests a database reopen, not a daemon or process restart.
        let placeholder = McStore::open_for_test(&StorageDescriptor {
            module_id: "prefix-audit-reopen-placeholder".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: f
                    ._dir
                    .path()
                    .join("placeholder.db")
                    .to_string_lossy()
                    .into(),
            },
        })
        .unwrap();
        // Release the original writer lease before acquiring it again.
        drop(std::mem::replace(&mut f.store, placeholder));
        f.store = McStore::open_for_test(&StorageDescriptor {
            module_id: "prefix-audit".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: f._dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        f.served = f.pass();
        assert_eq!(
            f.wire(),
            before_reopen,
            "{lane:?}: reopen changed held bytes"
        );
        assert!(!f.served.prefix_bust_permitted);
        f.next_user_turn("review-reopen-release");
        assert!(
            f.served.prefix_bust_permitted,
            "{lane:?}: release lost its permission"
        );
        assert!(
            f.landed(&before_reopen, &f.wire()),
            "{lane:?}: release lost work"
        );
        assert_eq!(f.mock.check(&f.wire()), None);
        f.served = f.pass();
        assert!(
            !f.served.prefix_bust_permitted,
            "{lane:?}: release needed a second bust"
        );
    }
}

#[test]
fn step2_review_model_switch_releases_parked_permission_without_new_user() {
    let mut f = Fixture::new("opencode-aisdk", false, Lane::Flush, "review-model-switch");
    f.tool_loop(4);
    f.arm_and_bust(false);
    f.served = f.pass();
    assert!(!f.served.prefix_bust_permitted);
    let turn = f.mock.turn;
    f.req.model_key = Some("anthropic/claude-opus-4-6".into());
    f.served = f.pass();
    assert_eq!(f.mock.turn, turn);
    assert!(f.served.prefix_bust_permitted);
    let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
    assert!(!meta.soft_refresh_pending);
    assert!(meta.held_release.is_none());
    assert!(f
        .store
        .load_pending_agent_drops(&f.req.session_id)
        .unwrap()
        .is_empty());
}

#[test]
fn step2_review_subagent_inherited_delta_cannot_spend_all_held_permission() {
    let mut f = Fixture::new("opencode-aisdk", true, Lane::DropFull, "review-child-delta");
    f.tool_loop(4);
    f.arm_and_bust(true);
    let end = f
        .req
        .messages
        .iter()
        .find(|m| m.mid == "step-4")
        .unwrap()
        .ordinal as i64;
    f.store
        .replace_compartments(
            &f.req.session_id,
            &[
                compartment(0, 1, 2, "seed-user", "seed-assistant", "Project setup"),
                compartment(1, 3, end, "prompt-1", "step-4", "Inherited publication"),
            ],
        )
        .unwrap();
    let before = f.wire();
    let before_meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
    for _ in 0..3 {
        f.served = f.pass();
        assert_eq!(
            f.wire(),
            before,
            "child changed the served prefix for inherited history work"
        );
        assert!(!f.served.prefix_bust_permitted);
        let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
        assert_eq!(meta.last_execute_ordinal, before_meta.last_execute_ordinal);
        assert_eq!(meta.m1_revision, before_meta.m1_revision);
        assert_eq!(meta.coverage_ordinal, before_meta.coverage_ordinal);
        assert_eq!(
            f.store
                .load_pending_agent_drops(&f.req.session_id)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn step2_review_parked_force_crosses_live_95_wall_without_spending_held_work() {
    let mut f = Fixture::new(
        "opencode-aisdk",
        false,
        Lane::DropFull,
        "review-band-crossing",
    );
    f.tool_loop(4);
    f.arm_and_bust(false);
    f.served = f.pass();
    let before = f.wire();
    for tokens in [90_000, 95_000, 96_000, 85_000] {
        f.set_usage(tokens);
        f.served = f.pass();
        assert_eq!(f.wire(), before, "usage={tokens}: held work changed bytes");
        assert_eq!(f.mock.check(&f.wire()), None);
        let meta = f.store.load_meta(&f.req.session_id).unwrap().meta;
        assert!(!meta.has_prior_emergency_drop);
        assert!(meta.held_release.is_some());
        assert_eq!(
            f.store
                .load_pending_agent_drops(&f.req.session_id)
                .unwrap()
                .len(),
            1
        );
    }
    // Caller usage is not provider-proven final-wire overflow evidence; it must not
    // invent a refusal. Separate host tests price known-over frozen requests.
    f.next_user_turn("review-band-release");
    assert!(f.served.prefix_bust_permitted);
    assert!(f
        .store
        .load_pending_agent_drops(&f.req.session_id)
        .unwrap()
        .is_empty());
}

#[test]
fn parked_force_cancels_when_pressure_ends() {
    let mut f = Fixture::new("opencode-aisdk", false, Lane::DropFull, "force-cancel");
    f.tool_loop(4);
    f.arm_and_bust(false);
    f.served = f.pass();
    audit_assert!(f
        .store
        .load_meta(&f.req.session_id)
        .unwrap()
        .meta
        .held_release
        .is_some());
    f.set_usage(20_000);
    f.served = f.pass();
    audit_assert!(f
        .store
        .load_meta(&f.req.session_id)
        .unwrap()
        .meta
        .held_release
        .is_none());
    f.next_user_turn("cancelled-force-next");
    audit_assert!(!f.served.prefix_bust_permitted);
    audit_assert_eq!(
        f.store
            .load_pending_agent_drops(&f.req.session_id)
            .unwrap()
            .len(),
        1
    );
}
