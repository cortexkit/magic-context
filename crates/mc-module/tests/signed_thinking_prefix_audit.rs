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

const PREFIX_ERROR: &str = "bound to a different conversation";
const MIDDLE_ERROR: &str = "thinking removed from the middle";
const LATEST_TURN_ERROR: &str = "latest assistant turn thinking modified";
const BYTES_ERROR: &str = "thinking bytes modified";

/// One provider-visible block: `[role, kind]`.
type Block = Value;

/// The strict-binding provider. See the TypeScript mock for the rules it enforces.
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
        if let Some(error) = self.check(request) {
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
    Todo,
    Caveman,
    Image,
    Placeholder,
}

const SUMMARY_TEXT: &str = "I have finished reading the parser and the lexer. The parser consumes tokens from the lexer, and the error recovery path is incomplete because it never resynchronises after an unexpected token.";
const COMPARTMENT_TITLE: &str = "Parser inspection";

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
}

impl Fixture {
    fn new(profile: &str, subagent: bool, lane: Lane) -> Self {
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
            "provider_id": "anthropic", "model_key": "anthropic/claude-opus-5-5",
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
        response
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
        let thinking = if with_thinking {
            Some(self.mock.respond(&request))
        } else {
            if let Some(error) = self.mock.check(&request) {
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
        // A realistic Rust-mode session already holds a compartment: the module
        // only prices SOFT reductions against a published history boundary.
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
            assert_eq!(self.mock.check(&self.wire()), None);
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
            assert_eq!(self.mock.check(&self.wire()), None, "loop step {n}");
        }
        self.wire()
    }

    fn next_user_turn(&mut self, mid: &str) {
        let text = format!(
            "Step {}: this part of the work is done and verified.",
            self.step + 1
        );
        self.respond(vec![json!({"type":"text","text":text})], vec![], true);
        assert_eq!(self.mock.check(&self.wire()), None);
        self.user_turn(
            mid,
            "Continue with the next part of the parser work; keep using tools until done.",
            vec![],
        );
        self.served = self.pass();
        assert_eq!(self.mock.check(&self.wire()), None);
    }

    fn set_usage(&mut self, tokens: u64) {
        self.req.usage = serde_json::from_value(
            json!({"current_total_input_tokens":tokens,"context_limit_tokens":100_000}),
        )
        .unwrap();
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
            assert_eq!(self.mock.check(&self.wire()), None);
        }
    }

    fn arm_and_bust(&mut self, subagent: bool) {
        let sid = self.req.session_id.clone();
        match self.lane {
            // The module strips a processed image on the same pass whose applied drop
            // advances the image watermark past it, so the image lane rides a drop.
            Lane::DropFull | Lane::Flush | Lane::Image => {
                self.store.append_pending_agent_drops(&sid, &["step-2-result-0#0".into()], 1).unwrap();
            }
            Lane::HardFold => {
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
            Lane::HardFold => text.contains(COMPARTMENT_TITLE),
            Lane::Todo => text.contains("Repair error recovery"),
            Lane::Caveman => !text.contains(SUMMARY_TEXT),
            Lane::Image => !text.contains("\"media\""),
            Lane::Placeholder => !text.contains("[dropped §998§]"),
        }
    }
}

/// Lanes the audit found landing an edit before kept signed thinking mid loop.
fn exposed(subagent: bool, lane: Lane) -> bool {
    !subagent && matches!(lane, Lane::HardFold | Lane::Todo | Lane::Placeholder)
}

fn mid_loop(profile: &str, subagent: bool, lane: Lane) {
    let mut f = Fixture::new(profile, subagent, lane);
    f.prepare();
    let before = f.tool_loop(4);
    f.arm_and_bust(subagent);
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
            "META mid-loop {lane:?} subagent={subagent}: action={} materialize={} bust={}",
            meta["action"], meta["materialize_reason"], meta["prefix_bust_permitted"]
        );
    }
    println!("AUDIT {profile} | subagent={subagent} | {lane:?}: {error:?}; laneLanded={landed}; nonThinkingEdit={non_thinking_edit}");
    if std::env::var("MC_AUDIT_STRICT").as_deref() == Ok("1") {
        assert_eq!(error, None, "{profile} subagent={subagent} {lane:?}");
        return;
    }
    if exposed(subagent, lane) {
        assert!(
            landed,
            "{profile} subagent={subagent} {lane:?}: the lane did not land"
        );
        assert_eq!(
            error,
            Some(PREFIX_ERROR),
            "{profile} subagent={subagent} {lane:?}"
        );
        return;
    }
    assert_eq!(error, None, "{profile} subagent={subagent} {lane:?}");
    assert!(
        !non_thinking_edit,
        "{profile} subagent={subagent} {lane:?}: held lane changed bytes"
    );
    assert!(
        !landed,
        "{profile} subagent={subagent} {lane:?}: held lane landed"
    );
    f.tool_loop(2);
}

fn control(profile: &str, lane: Lane) {
    let mut f = Fixture::new(profile, false, lane);
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
    assert!(
        landed,
        "{profile} {lane:?}: the control did not land the lane's edit"
    );
    if std::env::var("MC_AUDIT_STRICT").as_deref() != Ok("1") && profile == "claude-code-anthropic"
    {
        // The module keeps every older signed thinking block on a Claude Code bust:
        // the profile has no binding strip (reasoning_clear_cutoff_with_tags returns
        // None for prefix-bound models) and this repository has no Claude Code host
        // step that strips it. Whether the Claude Code client replays earlier-turn
        // thinking at all is for the gateway owner to confirm.
        assert_eq!(error, Some(PREFIX_ERROR), "{profile} {lane:?}");
        return;
    }
    assert_eq!(error, None, "{profile} {lane:?}");
    f.tool_loop(3);
}

// Lanes whose control lands its own edit in this fixture. Skeleton drops, dedup and
// supersession, the 85% force band, reasoning clearing and the stale ctx_reduce strip
// did not price a bust or select work here even at a new user turn, so a held result
// for them would be vacuous; the report covers them from the code.
const PRIMARY_LANES: [Lane; 8] = [
    Lane::DropFull,
    Lane::Wall95,
    Lane::Flush,
    Lane::HardFold,
    Lane::Todo,
    Lane::Caveman,
    Lane::Image,
    Lane::Placeholder,
];
// Subagent passes price a bust on execute (`m1_delta`), so these held results are not
// for want of permission.
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
