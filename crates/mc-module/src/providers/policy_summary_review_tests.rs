//! Adversarial review of the bounded policy summary.
//!
//! These tests drive the provider store directly: they write policy rows,
//! consumed tags, lineages and settings through SQL and the public store API,
//! then run a host hook that computes channel-1 inputs through
//! `channel1_inputs`. Before each hook writes, the harness replays the stored
//! summary itself and compares the result with a full recomputation over every
//! effective part (`transform::channel1_inputs_from_parts` for the inputs and
//! `build` for the summary). The comparison never panics, so a randomized run
//! can collect and shrink mismatching sequences.
//!
//! Operations are split into two classes. "Production" operations mirror a
//! store write the shipped code performs (admission inserts and re-arms,
//! promotion, deactivation, queueing, consuming a tag, an engine rewrite that
//! drops the summary first, lineage forks, settings changes, cache-busting
//! hooks). "Out-of-band" operations change a row in a way no shipped writer
//! does today (for example flipping a part's kind or moving a row to another
//! ordinal column); a mismatch there is a latent hazard, not a served-bytes
//! bug.
use super::*;
use mc_store::provider_records::{
    ProviderConversation, ProviderHookRequest, ProviderHookWrite, ProviderLineage,
    ProviderSessionKey,
};
use mc_store::McStore;
use serde_json::json;

const NAMESPACE: &str = "ses_review";
const TOOLS: [&str; 6] = ["read", "grep", "bash", "edit", "task", "bash_status"];

/// Deterministic xorshift generator; the crate has no RNG dependency.
#[derive(Clone)]
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// One step of a sequence. Selector fields are raw random numbers that the
/// harness maps onto whatever rows exist when the step runs, so a sequence
/// replays identically and can be shrunk by deleting steps.
#[derive(Clone, Debug)]
enum Op {
    /// An ordinary host hook (the observation point).
    Hook,
    /// A cache-busting hook.
    BustingHook,
    /// Admit a new message at the next ordinal of the current lineage.
    Append(u64),
    /// Promotion: mark every part with the chosen tag number served.
    Serve(u64),
    /// Deactivate every part with the chosen tag number (burn or unserved reset).
    Deactivate(u64),
    /// Queue the chosen tag number for release.
    Queue(u64),
    /// Consume the chosen tag number in the engine namespace.
    Consume(u64),
    /// Admission re-arm: an inactive, unconsumed part becomes active again
    /// with a newly allocated tag number, written with the admission upsert.
    Rearm(u64),
    /// Engine rewrite: drop the summary, then mark one arc's results reduced
    /// and change one part's stored measurement.
    EngineRewrite(u64),
    /// Change the protection floor in the stored engine policy.
    Floor(u64),
    /// Change the stored engine policy's protected-tool keep counts.
    Keep(u64),
    /// Fork a child lineage from the current one at an earlier ordinal.
    Fork(u64),
    /// In a forked lineage, write the child's own copy of an ancestor block.
    Shadow(u64),
    // ---- Out-of-band operations: no shipped writer performs these. ----
    /// Flip a non-header part to a header or back.
    KindFlip(u64),
    /// Change a part's tag token count in place.
    Tokens(u64),
    /// Change a tool part's tool name in place.
    Rename(u64),
    /// Mark one tool result reduced without dropping the summary.
    ReduceInPlace(u64),
    /// Rewrite an existing row with INSERT OR REPLACE.
    Replace(u64),
    /// Delete one row.
    Delete(u64),
    /// Move the conversation to another engine namespace whose consumed tags differ.
    Namespace(u64),
    /// Change a part's stored measurement tokens in place.
    Measure(u64),
    /// Change only the `ordinal` column of a row (no policy_json change).
    OrdinalColumn(u64),
}

fn production_op(rng: &mut Rng, forked: bool) -> Op {
    let s = rng.next();
    match rng.below(100) {
        0..=29 => Op::Append(s),
        30..=41 => Op::Serve(s),
        42..=49 => Op::Deactivate(s),
        50..=57 => Op::Queue(s),
        58..=65 => Op::Consume(s),
        66..=73 => Op::Rearm(s),
        74..=76 => Op::EngineRewrite(s),
        77..=79 => Op::Floor(s),
        80..=81 => Op::Keep(s),
        82..=84 => Op::Fork(s),
        85..=87 if forked => Op::Shadow(s),
        _ => Op::Append(s),
    }
}

fn out_of_band_op(rng: &mut Rng) -> Op {
    let s = rng.next();
    match rng.below(9) {
        0 => Op::KindFlip(s),
        1 => Op::Tokens(s),
        2 => Op::Rename(s),
        3 => Op::ReduceInPlace(s),
        4 => Op::Replace(s),
        5 => Op::Delete(s),
        6 => Op::Namespace(s),
        7 => Op::Measure(s),
        _ => Op::OrdinalColumn(s),
    }
}

/// A random sequence: a seeded prefix, then mixed operations with hooks.
fn sequence(seed: u64, out_of_band: bool) -> Vec<Op> {
    let mut rng = Rng::new(seed);
    let mut ops = Vec::new();
    for _ in 0..(3 + rng.below(4)) {
        ops.push(Op::Append(rng.next()));
    }
    ops.push(Op::Hook);
    let mut forked = false;
    for _ in 0..(25 + rng.below(20)) {
        let op = if out_of_band && rng.chance(20) {
            out_of_band_op(&mut rng)
        } else {
            production_op(&mut rng, forked)
        };
        forked |= matches!(op, Op::Fork(_));
        ops.push(op);
        if rng.chance(45) {
            ops.push(if rng.chance(4) {
                Op::BustingHook
            } else {
                Op::Hook
            });
        }
    }
    ops.push(Op::Hook);
    ops
}

fn q(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// SQL choosing one row deterministically from a selector: `rowid` order is a
/// function of the operations so far, so replays pick the same row.
fn pick(selector: u64) -> String {
    format!(
        "ORDER BY (rowid * {}) % 1000003, rowid LIMIT 1",
        selector % 997 + 1
    )
}

#[derive(Default, Debug)]
struct Observation {
    /// The stored summary was replayed and served (no fallback fired).
    replayed: bool,
    mismatches: Vec<String>,
}

#[derive(Default, Debug)]
struct Outcome {
    hooks: usize,
    replays: usize,
    /// First mismatch: the index of the hook step and what differed.
    mismatch: Option<(usize, String)>,
    errors: Vec<String>,
}

struct Fixture {
    _dir: std::rc::Rc<tempfile::TempDir>,
    store: std::rc::Rc<McStore>,
    key: ProviderSessionKey,
    conv: String,
    lineage: ProviderLineage,
    namespace: String,
    next_ordinal: u64,
    next_tag: i64,
    next_arc: u64,
    forks: u64,
    /// Whether the current lineage row exists (a hook creates it).
    lineage_stored: bool,
    /// Arcs whose call has no result yet: (arc id, tool name).
    open_arcs: Vec<(String, String)>,
    floor: u64,
    tools: BTreeMap<String, usize>,
}

fn kind_of(kind: &str) -> TailHygienePartKind {
    match kind {
        "tool_call" => TailHygienePartKind::ToolInput,
        "tool_result" => TailHygienePartKind::ToolOutput,
        _ => TailHygienePartKind::Text,
    }
}

#[allow(clippy::too_many_arguments)]
fn policy_part(
    mid: &str,
    ordinal: u64,
    index: i64,
    kind: &str,
    role: &str,
    tool: &str,
    arc: Option<String>,
    tag: Option<(&str, i64)>,
    tokens: i64,
    served: bool,
) -> ProviderPolicyPart {
    let block_id = if kind == "header" {
        format!("{mid}#@message")
    } else {
        format!("{mid}#{index}")
    };
    ProviderPolicyPart {
        mid: mid.to_string(),
        ordinal,
        block_id: block_id.clone(),
        block_index: index,
        kind: kind.to_string(),
        role: role.to_string(),
        measurement: TailHygienePartMeasurement {
            key: format!("{block_id}\0{kind}"),
            content_hash: format!("h-{block_id}"),
            kind: kind_of(kind),
            tokens,
            u_tokens: 0,
            tag_number: None,
            tag_status: None,
            protected: false,
            queued_for_drop: false,
        },
        tag_kind: tag.map(|(kind, _)| kind.to_string()),
        tag_number: tag.map(|(_, number)| number),
        tag_tokens: if tag.is_some() { tokens } else { 0 },
        tool_name: tool.to_string(),
        arc_id: arc,
        subject_part: String::new(),
        active: true,
        served,
        reduced: false,
        queued: false,
        real_user: false,
        created_at_ms: None,
        completed_at_ms: None,
    }
}

/// Compare channel-1 inputs as the hook serves them (the frozen part list is
/// never part of a served replay; both sides drop it).
fn diff_inputs(left: &Channel1PolicyInputs, right: &Channel1PolicyInputs) -> Option<String> {
    let mut a = left.baseline.clone();
    a.baseline_parts.clear();
    let mut b = right.baseline.clone();
    b.baseline_parts.clear();
    if a != b {
        return Some(format!("baseline {a:?} != full {b:?}"));
    }
    if left.users != right.users {
        return Some(format!("users {} != full {}", left.users, right.users));
    }
    if left.tool_outputs != right.tool_outputs {
        return Some(format!(
            "tool outputs {} != full {}",
            left.tool_outputs, right.tool_outputs
        ));
    }
    if left.hint != right.hint {
        return Some(format!("hint {:?} != full {:?}", left.hint, right.hint));
    }
    None
}

/// Replay the stored summary exactly as `channel1_inputs` would and compare it
/// with the full computation. Returns whether a replay was served.
fn probe(
    index: &ProviderPolicyIndex<'_>,
    engine_policy: &Value,
    floor: u64,
    tools: &BTreeMap<String, usize>,
) -> Result<Observation, ProviderError> {
    let mut observation = Observation::default();
    let settings = Settings::resolve(engine_policy, floor, tools, false, None);
    if settings.previous.is_none() {
        return Ok(observation);
    }
    let key = settings.key(index);
    let Some(held) = index
        .summary()?
        .and_then(|raw| serde_json::from_str::<PolicySummary>(&raw).ok())
        .filter(|summary| summary.key == key)
    else {
        return Ok(observation);
    };
    let Some(next) = replay(index, held, &settings)? else {
        return Ok(observation);
    };
    let Some(inputs) = inputs_from_summary(&next, &settings, false) else {
        return Ok(observation);
    };
    observation.replayed = true;
    let parts = index.all_parts()?;
    let full = transform::channel1_inputs_from_parts(
        &parts,
        engine_policy,
        floor,
        tools,
        false,
        false,
        None,
    );
    if let Some(difference) = diff_inputs(&inputs, &full) {
        observation
            .mismatches
            .push(format!("replayed inputs: {difference}"));
    }
    match build(&parts, &settings, next.key.clone(), None) {
        None => observation
            .mismatches
            .push("rebuild refused a summary the replay produced".into()),
        Some(rebuilt) => {
            let mut comparable = next.clone();
            for (tier, list) in &mut comparable.hint {
                if rebuilt.hint.get(tier).is_some_and(|held| held.complete) {
                    list.complete = true;
                }
            }
            if comparable != rebuilt {
                observation.mismatches.push(format!(
                    "replayed summary {comparable:?} != rebuilt {rebuilt:?}"
                ));
            }
        }
    }
    Ok(observation)
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&crate::test_support::descriptor(dir.path())).unwrap();
        Self::conversation(std::rc::Rc::new(dir), std::rc::Rc::new(store), "opencode")
    }

    /// Another conversation of the same session and engine namespace in the
    /// same store (for example a second harness binding).
    fn sibling(&self, harness: &str) -> Self {
        Self::conversation(self._dir.clone(), self.store.clone(), harness)
    }

    fn conversation(
        dir: std::rc::Rc<tempfile::TempDir>,
        store: std::rc::Rc<McStore>,
        harness: &str,
    ) -> Self {
        let key = ProviderSessionKey {
            project_root: "/review".into(),
            session: NAMESPACE.into(),
            harness: harness.into(),
        };
        let floor = 3_000;
        let tools: BTreeMap<String, usize> =
            [("read".to_string(), 1), ("grep".to_string(), 2)].into();
        store
            .save_provider_conversation(
                &key,
                &ProviderConversation {
                    lineage_id: "L".into(),
                    engine_namespace: NAMESPACE.into(),
                    hook_counters_json: json!({"engine_policy":{"protected_tokens":floor}})
                        .to_string(),
                    ..ProviderConversation::default()
                },
            )
            .unwrap();
        let conv = key.conversation_key();
        let fixture = Self {
            _dir: dir,
            store,
            key,
            conv,
            lineage: ProviderLineage {
                lineage_id: "L".into(),
                first_ordinal: 1,
                descends_from: None,
                through_ordinal: None,
            },
            namespace: NAMESPACE.into(),
            next_ordinal: 1,
            next_tag: 1,
            next_arc: 0,
            forks: 0,
            lineage_stored: true,
            open_arcs: Vec::new(),
            floor,
            tools,
        };
        // Create the root lineage row before any policy rows reference it.
        fixture
            .store
            .commit_provider_hook(&fixture.key, fixture.request(), |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    (),
                ))
            })
            .unwrap();
        fixture
    }

    fn request(&self) -> ProviderHookRequest<'_> {
        ProviderHookRequest {
            lineage: &self.lineage,
            message: None,
            served_through_ordinal: None,
            unserved_subjects: &[],
            repeat_subject: None,
        }
    }

    fn sql(&self, sql: &str) {
        self.store
            .execute_tag_sql_for_test(sql)
            .unwrap_or_else(|e| panic!("{e}: {sql}"));
    }

    /// SQL predicate selecting this conversation's rows (unqualified column names).
    fn mine(&self) -> String {
        format!("conv_key={}", q(&self.conv))
    }

    fn tag(&self, selector: u64) -> i64 {
        1 + (selector % (self.next_tag.max(2) as u64 - 1)) as i64
    }

    fn insert(&self, lineage: &str, part: &ProviderPolicyPart) {
        self.sql(&format!(
            "INSERT INTO mc_provider_policy_parts_v1 VALUES ({c},{l},{o},{b},{j},json_extract({c},'$[1]'))",
            c = q(&self.conv),
            l = q(lineage),
            o = part.ordinal,
            b = q(&part.block_id),
            j = q(&serde_json::to_string(part).unwrap()),
        ));
    }

    fn append(&mut self, selector: u64) {
        let mut rng = Rng::new(selector);
        let ordinal = self.next_ordinal;
        self.next_ordinal += 1;
        let mid = format!("m{ordinal}");
        let user = rng.chance(40);
        let role = if user { "user" } else { "assistant" };
        self.sql(&format!(
            "INSERT INTO mc_provider_messages_v1 VALUES ({c},{l},{ordinal},{m},X'7b7d',json_extract({c},'$[1]'))",
            c = q(&self.conv),
            l = q(&self.lineage.lineage_id),
            m = q(&mid),
        ));
        let mut header = policy_part(&mid, ordinal, -1, "header", role, "", None, None, 0, true);
        header.real_user = user && rng.chance(70);
        let mut parts = vec![header];
        let mut index = 0i64;
        for _ in 0..(1 + rng.below(3)) {
            let tokens = rng.below(1_500) as i64;
            let served = rng.chance(70);
            match rng.below(10) {
                0..=3 => {
                    let tag = rng.chance(30).then(|| {
                        self.next_tag += 1;
                        ("message", self.next_tag - 1)
                    });
                    parts.push(policy_part(
                        &mid, ordinal, index, "text", role, "", None, tag, tokens, served,
                    ));
                    index += 1;
                }
                4..=7 => {
                    let tool = TOOLS[rng.below(TOOLS.len() as u64) as usize];
                    let arc = format!("arc{}", self.next_arc);
                    self.next_arc += 1;
                    parts.push(policy_part(
                        &mid,
                        ordinal,
                        index,
                        "tool_call",
                        role,
                        tool,
                        Some(arc.clone()),
                        None,
                        rng.below(200) as i64,
                        served,
                    ));
                    index += 1;
                    if rng.chance(15) {
                        self.open_arcs.push((arc, tool.to_string()));
                    } else {
                        self.next_tag += 1;
                        parts.push(policy_part(
                            &mid,
                            ordinal,
                            index,
                            "tool_result",
                            role,
                            tool,
                            Some(arc),
                            Some(("tool_result", self.next_tag - 1)),
                            tokens,
                            served,
                        ));
                        index += 1;
                    }
                }
                _ => {
                    if self.open_arcs.is_empty() {
                        continue;
                    }
                    let at = rng.below(self.open_arcs.len() as u64) as usize;
                    let (arc, tool) = self.open_arcs.remove(at);
                    self.next_tag += 1;
                    parts.push(policy_part(
                        &mid,
                        ordinal,
                        index,
                        "tool_result",
                        role,
                        &tool,
                        Some(arc),
                        Some(("tool_result", self.next_tag - 1)),
                        tokens,
                        served,
                    ));
                    index += 1;
                }
            }
        }
        let lineage = self.lineage.lineage_id.clone();
        for part in &parts {
            self.insert(&lineage, part);
        }
    }

    fn set_by_tag(&self, selector: u64, field: &str, value: &str) {
        self.sql(&format!(
            "UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.{field}',json('{value}')) WHERE {} AND json_extract(policy_json,'$.tag_number')={}",
            self.mine(),
            self.tag(selector)
        ));
    }

    /// Update one chosen row of this conversation matching `filter`.
    fn update_one(&self, selector: u64, filter: &str, set: &str) {
        self.sql(&format!(
            "UPDATE mc_provider_policy_parts_v1 SET {set} WHERE rowid=(SELECT rowid FROM mc_provider_policy_parts_v1 WHERE {} AND {filter} {})",
            self.mine(),
            pick(selector)
        ));
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::Hook | Op::BustingHook => unreachable!("hooks run in `run`"),
            Op::Append(s) => self.append(s),
            Op::Serve(s) => self.set_by_tag(s, "served", "true"),
            Op::Deactivate(s) => self.set_by_tag(s, "active", "false"),
            Op::Queue(s) => self.set_by_tag(s, "queued", "true"),
            Op::Consume(s) => self.sql(&format!(
                "INSERT INTO mc_provider_consumed_tags_v1 VALUES ({n},{},{n}) ON CONFLICT DO NOTHING",
                self.tag(s),
                n = q(&self.namespace),
            )),
            Op::Rearm(s) => {
                let number = self.next_tag;
                self.next_tag += 1;
                self.sql(&format!(
                    "INSERT INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,block_id,json_set(policy_json,'$.active',json('true'),'$.tag_number',{number}),session FROM mc_provider_policy_parts_v1 p WHERE {} AND lineage_id={} AND json_extract(policy_json,'$.active')=0 AND json_extract(policy_json,'$.tag_number') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM mc_provider_consumed_tags_v1 t WHERE t.engine_namespace={} AND t.tag_number=json_extract(p.policy_json,'$.tag_number')) {} ON CONFLICT(conv_key,lineage_id,block_id) DO UPDATE SET policy_json=excluded.policy_json",
                    self.mine(),
                    q(&self.lineage.lineage_id),
                    q(&self.namespace),
                    pick(s)
                ));
            }
            Op::EngineRewrite(s) => {
                let c = q(&self.conv);
                self.sql(&format!(
                    "DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key={c};
                     DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key={c};"
                ));
                self.sql(&format!(
                    "UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.reduced',json('true')) WHERE {m} AND json_extract(policy_json,'$.kind')='tool_result' AND json_extract(policy_json,'$.arc_id')=(SELECT json_extract(policy_json,'$.arc_id') FROM mc_provider_policy_parts_v1 WHERE {m} AND json_extract(policy_json,'$.arc_id') IS NOT NULL {})",
                    pick(s),
                    m = self.mine()
                ));
                self.update_one(
                    s / 7,
                    "json_extract(policy_json,'$.kind')!='header'",
                    &format!(
                        "policy_json=json_set(policy_json,'$.measurement.tokens',{})",
                        s % 900
                    ),
                );
            }
            Op::Floor(s) => self.sql(&format!(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json=json_set(hook_counters_json,'$.engine_policy.protected_tokens',{}) WHERE {}",
                [500, 1_500, 3_000, 6_000][(s % 4) as usize],
                self.mine()
            )),
            Op::Keep(s) => self.sql(&format!(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json=json_set(hook_counters_json,'$.engine_policy.protected_tools',json('{{\"read\":{},\"grep\":{},\"bash\":{}}}')) WHERE {}",
                s % 3,
                (s / 3) % 3,
                (s / 9) % 2,
                self.mine()
            )),
            Op::Fork(s) => {
                // A fork descends from a stored lineage only.
                if self.next_ordinal < 3 || !self.lineage_stored {
                    return;
                }
                self.lineage_stored = false;
                let cut = 1 + s % (self.next_ordinal - 2);
                self.forks += 1;
                self.lineage = ProviderLineage {
                    lineage_id: format!("F{}", self.forks),
                    first_ordinal: cut + 1,
                    descends_from: Some(self.lineage.lineage_id.clone()),
                    through_ordinal: Some(cut),
                };
                self.next_ordinal = cut + 1;
                self.open_arcs.clear();
            }
            Op::Shadow(s) => {
                let (Some(parent), Some(cut)) =
                    (self.lineage.descends_from.clone(), self.lineage.through_ordinal)
                else {
                    return;
                };
                let child = q(&self.lineage.lineage_id);
                self.sql(&format!(
                    "INSERT INTO mc_provider_policy_parts_v1 SELECT conv_key,{child},ordinal,block_id,json_set(policy_json,'$.served',json('true')),session FROM mc_provider_policy_parts_v1 p WHERE {} AND lineage_id={} AND ordinal<={cut} AND NOT EXISTS(SELECT 1 FROM mc_provider_policy_parts_v1 d WHERE d.conv_key=p.conv_key AND d.lineage_id={child} AND d.block_id=p.block_id) {}",
                    self.mine(),
                    q(&parent),
                    pick(s)
                ));
            }
            Op::KindFlip(s) => self.update_one(
                s,
                "json_extract(policy_json,'$.kind') IN ('text','header')",
                "policy_json=json_set(policy_json,'$.kind',CASE json_extract(policy_json,'$.kind') WHEN 'header' THEN 'text' ELSE 'header' END)",
            ),
            Op::Tokens(s) => self.update_one(
                s,
                "json_extract(policy_json,'$.tag_number') IS NOT NULL",
                &format!("policy_json=json_set(policy_json,'$.tag_tokens',{})", s % 1_500),
            ),
            Op::Rename(s) => self.update_one(
                s,
                "json_extract(policy_json,'$.arc_id') IS NOT NULL",
                &format!(
                    "policy_json=json_set(policy_json,'$.tool_name',{})",
                    q(TOOLS[(s % TOOLS.len() as u64) as usize])
                ),
            ),
            Op::ReduceInPlace(s) => self.update_one(
                s,
                "json_extract(policy_json,'$.kind')='tool_result'",
                "policy_json=json_set(policy_json,'$.reduced',json('true'))",
            ),
            Op::Replace(s) => self.sql(&format!(
                "INSERT OR REPLACE INTO mc_provider_policy_parts_v1 SELECT conv_key,lineage_id,ordinal,block_id,json_set(policy_json,'$.served',json('true'),'$.tag_tokens',{}),session FROM mc_provider_policy_parts_v1 WHERE {} {}",
                s % 1_500,
                self.mine(),
                pick(s)
            )),
            Op::Delete(s) => self.sql(&format!(
                "DELETE FROM mc_provider_policy_parts_v1 WHERE rowid=(SELECT rowid FROM mc_provider_policy_parts_v1 WHERE {} {})",
                self.mine(),
                pick(s)
            )),
            Op::Namespace(s) => {
                let other = if self.namespace == NAMESPACE {
                    "ses_other"
                } else {
                    NAMESPACE
                };
                // The other namespace has consumed a different set of numbers.
                for number in [self.tag(s), self.tag(s / 5), self.tag(s / 25)] {
                    self.sql(&format!(
                        "INSERT INTO mc_provider_consumed_tags_v1 VALUES ({o},{number},{o}) ON CONFLICT DO NOTHING",
                        o = q(other)
                    ));
                }
                self.sql(&format!(
                    "UPDATE mc_provider_conversations_v2 SET engine_namespace={} WHERE {}",
                    q(other),
                    self.mine()
                ));
                self.namespace = other.into();
            }
            Op::Measure(s) => self.update_one(
                s,
                "json_extract(policy_json,'$.kind')!='header'",
                &format!(
                    "policy_json=json_set(policy_json,'$.measurement.tokens',{})",
                    s % 1_500
                ),
            ),
            Op::OrdinalColumn(s) => {
                if s % 2 == 0 {
                    self.update_one(s, "1", "ordinal=ordinal+1000")
                } else {
                    self.update_one(s, "1", "lineage_id='detached'||rowid")
                }
            }
        }
    }

    /// Read through a hook's policy index without changing the summary.
    fn peek<T>(
        &self,
        read: impl FnOnce(&ProviderPolicyIndex<'_>) -> Result<T, ProviderError>,
    ) -> T {
        self.store
            .commit_provider_hook(&self.key, self.request(), |ctx| {
                let value = read(&ctx.policy_index)?;
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    value,
                ))
            })
            .unwrap()
    }

    fn logged_changes(&self) -> usize {
        self.peek(|index| Ok(index.changes(1_000_000)?.map_or(0, |c| c.len())))
    }

    /// One host hook: probe the replay, then compute and store as the
    /// provider step does (including the baseline refreeze bookkeeping).
    fn hook(&self, cache_busting: bool) -> Result<Observation, ProviderError> {
        let floor = self.floor;
        let tools = self.tools.clone();
        self.store
            .commit_provider_hook(&self.key, self.request(), |ctx| {
                let engine_policy = ctx.counters["engine_policy"].clone();
                let mut observation = if cache_busting {
                    Observation::default()
                } else {
                    probe(&ctx.policy_index, &engine_policy, floor, &tools)?
                };
                let _off = without_full_check();
                let (inputs, summary) = channel1_inputs(
                    &ctx.policy_index,
                    &engine_policy,
                    floor,
                    &tools,
                    false,
                    cache_busting,
                    None,
                )?;
                let parts = ctx.policy_index.all_parts()?;
                let full = transform::channel1_inputs_from_parts(
                    &parts,
                    &engine_policy,
                    floor,
                    &tools,
                    false,
                    cache_busting,
                    None,
                );
                if let Some(difference) = diff_inputs(&inputs, &full) {
                    observation
                        .mismatches
                        .push(format!("served inputs: {difference}"));
                }
                let mut counters = ctx.counters.clone();
                if cache_busting {
                    counters["engine_policy"]["calibration"] = serde_json::to_value(
                        crate::decision_calibration::DecisionCalibration::freeze_for_model(None),
                    )
                    .unwrap();
                }
                if ctx
                    .counters
                    .pointer("/engine_policy/baseline/baseline_generation")
                    .and_then(Value::as_u64)
                    != Some(inputs.baseline.baseline_generation)
                {
                    counters["policy_baseline_updates"] = json!(inputs
                        .baseline
                        .baseline_parts
                        .iter()
                        .map(|m| json!({"block_id":m.key.split('\0').next().unwrap_or(""),"measurement":m}))
                        .collect::<Vec<_>>());
                    let mut baseline = inputs.baseline.clone();
                    baseline.baseline_parts.clear();
                    if !counters["engine_policy"].is_object() {
                        counters["engine_policy"] = json!({});
                    }
                    counters["engine_policy"]["baseline"] = serde_json::to_value(baseline).unwrap();
                    counters["engine_policy"]["baseline_len"] =
                        json!(inputs.baseline.baseline_parts.len());
                }
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters,
                        policy_summary: summary,
                    },
                    observation,
                ))
            })
    }
}

fn run(ops: &[Op]) -> Outcome {
    let mut fixture = Fixture::new();
    let mut outcome = Outcome::default();
    for (at, op) in ops.iter().enumerate() {
        match op {
            Op::Hook | Op::BustingHook => match fixture.hook(matches!(op, Op::BustingHook)) {
                Ok(observation) => {
                    fixture.lineage_stored = true;
                    outcome.hooks += 1;
                    outcome.replays += usize::from(observation.replayed);
                    if outcome.mismatch.is_none() {
                        if let Some(first) = observation.mismatches.into_iter().next() {
                            outcome.mismatch = Some((at, first));
                        }
                    }
                }
                Err(error) => outcome.errors.push(format!("step {at}: {error}")),
            },
            op => fixture.apply(op),
        }
    }
    outcome
}

/// Greedily delete steps while a mismatch remains, then cut after it.
fn shrink(mut ops: Vec<Op>) -> Vec<Op> {
    if let Some((at, _)) = run(&ops).mismatch {
        ops.truncate(at + 1);
    }
    loop {
        let mut changed = false;
        let mut index = ops.len();
        while index > 0 {
            index -= 1;
            let mut candidate = ops.clone();
            candidate.remove(index);
            if let Some((at, _)) = run(&candidate).mismatch {
                candidate.truncate(at + 1);
                ops = candidate;
                changed = true;
                index = index.min(ops.len());
            }
        }
        if !changed {
            return ops;
        }
    }
}

fn report(
    label: &str,
    seeds: std::ops::Range<u64>,
    out_of_band: bool,
) -> Vec<(u64, Vec<Op>, String)> {
    let (mut hooks, mut replays) = (0, 0);
    let mut found = Vec::new();
    for seed in seeds.clone() {
        let ops = sequence(seed, out_of_band);
        let outcome = run(&ops);
        assert!(
            outcome.errors.is_empty(),
            "{label} seed {seed}: hook errors {:?}",
            outcome.errors
        );
        hooks += outcome.hooks;
        replays += outcome.replays;
        if let Some((_, what)) = outcome.mismatch {
            found.push((seed, ops, what));
        }
    }
    println!(
        "{label}: {} sequences, {hooks} hooks, {replays} replayed and compared, {} mismatching sequences",
        seeds.end - seeds.start,
        found.len()
    );
    found
}

/// The production-shaped differential: 600 random sequences of store writes the
/// shipped code performs, with every replayed hook compared against the full
/// computation. A mismatch is shrunk to a minimal sequence.
#[test]
fn production_writes_replay_equals_full_computation_over_600_sequences() {
    let found = report("production", 0..600, false);
    if let Some((seed, ops, what)) = found.into_iter().next() {
        let minimal = shrink(ops);
        panic!("seed {seed}: {what}\nminimal sequence: {minimal:?}");
    }
}

/// The same differential including writes no shipped writer performs today:
/// each must be logged, drop the summary or take a replay fallback (F1-F3 in
/// docs/reports/provider-policy-summary-review.md were the gaps).
#[test]
fn out_of_band_writes_replay_equals_full_computation_over_600_sequences() {
    let found = report("out-of-band", 1_000..1_600, true);
    let mut minimal: BTreeMap<String, (u64, Vec<Op>, String)> = BTreeMap::new();
    for (seed, ops, what) in found.iter().take(12) {
        let shrunk = shrink(ops.clone());
        let label = shrunk
            .iter()
            .filter(|op| !matches!(op, Op::Hook | Op::BustingHook | Op::Append(_)))
            .map(|op| format!("{op:?}").split('(').next().unwrap().to_string())
            .collect::<Vec<_>>()
            .join("+");
        let replace = minimal
            .get(&label)
            .is_none_or(|(_, held, _)| shrunk.len() < held.len());
        if replace {
            minimal.insert(label, (*seed, shrunk, what.clone()));
        }
    }
    for (label, (seed, ops, what)) in &minimal {
        println!("[{label}] seed {seed}: {what}\n  minimal: {ops:?}");
    }
    assert!(found.is_empty(), "{} mismatching sequences", found.len());
}

/// Non-vacuity of the probe: a summary whose stored real-user count is off by
/// one is replayed, and both the probe and the served-inputs check report it.
#[test]
fn differential_detects_a_tampered_summary() {
    let mut fixture = Fixture::new();
    for seed in 1..=4 {
        fixture.append(seed);
    }
    let first = fixture.hook(false).unwrap();
    assert!(!first.replayed && first.mismatches.is_empty(), "{first:?}");
    fixture.append(9);
    let clean = fixture.hook(false).unwrap();
    assert!(clean.replayed && clean.mismatches.is_empty(), "{clean:?}");
    fixture.append(10);
    fixture.sql(&format!(
        "UPDATE mc_provider_policy_summaries_v1 SET summary_json=json_set(summary_json,'$.totals.users',json_extract(summary_json,'$.totals.users')+1) WHERE {}",
        fixture.mine()
    ));
    let tampered = fixture.hook(false).unwrap();
    assert!(tampered.replayed, "{tampered:?}");
    assert!(
        tampered
            .mismatches
            .iter()
            .any(|m| m.starts_with("replayed inputs: users"))
            && tampered
                .mismatches
                .iter()
                .any(|m| m.starts_with("served inputs: users")),
        "{tampered:?}"
    );
}

fn assert_clean(observation: &Observation, replayed: bool) {
    assert!(
        observation.mismatches.is_empty(),
        "mismatch: {:?}",
        observation.mismatches
    );
    assert_eq!(observation.replayed, replayed, "{observation:?}");
}

/// The change log is capped at 4,096 rows: exactly 4,096 logged changes still
/// replay (and match), one more rebuilds from every part, and the rebuild
/// clears the log so the next hook replays again.
#[test]
fn change_log_cap_replays_at_4096_and_rebuilds_at_4097() {
    let mut fixture = Fixture::new();
    fixture.append(1);
    fixture.append(2);
    let template = serde_json::to_string(&policy_part(
        "bulk",
        0,
        0,
        "text",
        "assistant",
        "",
        None,
        None,
        10,
        true,
    ))
    .unwrap();
    fixture.sql(&format!(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
         INSERT INTO mc_provider_policy_parts_v1
         SELECT {c},'L',2+i,'bulk'||i||'#0',json_set({t},'$.mid','bulk'||i,'$.ordinal',2+i,'$.block_id','bulk'||i||'#0','$.measurement.key','bulk'||i||'#0'||char(0)||'text'),json_extract({c},'$[1]') FROM n",
        c = q(&fixture.conv),
        t = q(&template)
    ));
    fixture.next_ordinal = 5_003;
    assert_clean(&fixture.hook(false).unwrap(), false);
    let touch = |rows: u64, value: u64| {
        format!(
            "UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.created_at_ms',{value}) WHERE {} AND block_id LIKE 'bulk%' AND ordinal<{}",
            fixture.mine(),
            3 + rows
        )
    };
    fixture.sql(&touch(4_096, 1));
    assert_eq!(fixture.logged_changes(), 4_096);
    assert_clean(&fixture.hook(false).unwrap(), true);
    assert_eq!(fixture.logged_changes(), 0);
    fixture.sql(&touch(4_097, 2));
    assert_eq!(fixture.logged_changes(), 4_097);
    assert_clean(&fixture.hook(false).unwrap(), false);
    assert_eq!(fixture.logged_changes(), 0);
    fixture.append(3);
    assert_clean(&fixture.hook(false).unwrap(), true);
}

/// Two conversations of one session share the engine namespace, so consuming
/// a tag number deactivates both conversations' parts. The consumed-tag
/// trigger logs the change for each conversation that keeps a summary, and
/// both replays match the full computation.
#[test]
fn consuming_a_shared_tag_replays_both_conversations_exactly() {
    let mut first = Fixture::new();
    let mut second = first.sibling("pi");
    for fixture in [&mut first, &mut second] {
        for seed in 1..=4 {
            fixture.append(seed);
        }
        assert_clean(&fixture.hook(false).unwrap(), false);
        let ordinal = fixture.next_ordinal;
        fixture.next_ordinal += 1;
        let part = policy_part(
            "late",
            ordinal,
            0,
            "tool_result",
            "assistant",
            "grep",
            Some("arc-late".into()),
            Some(("tool_result", 1_000)),
            900,
            false,
        );
        fixture.insert("L", &part);
        let observation = fixture.hook(false).unwrap();
        assert!(observation.mismatches.is_empty(), "{observation:?}");
    }
    first.sql(&format!(
        "INSERT INTO mc_provider_consumed_tags_v1 VALUES ({n},1000,{n})",
        n = q(NAMESPACE)
    ));
    assert_eq!(first.logged_changes(), 1);
    assert_eq!(second.logged_changes(), 1);
    assert_clean(&first.hook(false).unwrap(), true);
    assert_clean(&second.hook(false).unwrap(), true);
}

/// A hook whose write fails after its summary was saved (here: an answer tag
/// that does not advance the high water, refused after `save_policy_summary_tx`
/// ran) rolls the summary back with everything else. The previous summary and
/// its change log survive, and the next hook replays them exactly.
#[test]
fn a_hook_failing_after_the_summary_write_rolls_the_summary_back() {
    let mut fixture = Fixture::new();
    for seed in 1..=4 {
        fixture.append(seed);
    }
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.append(5);
    let summary = fixture.peek(|index| index.summary());
    let logged = fixture.logged_changes();
    assert!(summary.is_some() && logged > 0);
    let (floor, tools) = (fixture.floor, fixture.tools.clone());
    let failed = fixture
        .store
        .commit_provider_hook(&fixture.key, fixture.request(), |ctx| {
            let (_, next) = channel1_inputs(
                &ctx.policy_index,
                &ctx.counters["engine_policy"],
                floor,
                &tools,
                false,
                false,
                None,
            )?;
            assert!(next.is_some(), "the failing hook carries a new summary");
            let subject = mc_store::provider_records::ProviderSubject {
                subject_mid: "x".into(),
                hook: "post_tool".into(),
                subject_part: String::new(),
            };
            Ok((
                ProviderHookWrite {
                    answer: Some(mc_store::provider_records::ProviderHookAnswer {
                        subject,
                        ordinal: 0,
                        ops_json: "[]".into(),
                        tags: vec![mc_store::provider_records::ProviderAnswerTag {
                            number: 0,
                            block_id: "x#0".into(),
                            kind: "tool_result".into(),
                            source: "tool".into(),
                            token_count: 1,
                            created_at_ms: 0,
                        }],
                    }),
                    counters: ctx.counters.clone(),
                    policy_summary: next,
                },
                (),
            ))
        });
    assert!(
        matches!(&failed, Err(ProviderError::Transient(reason)) if reason.contains("high water")),
        "{:?}",
        failed.err()
    );
    assert_eq!(fixture.peek(|index| index.summary()), summary);
    assert_eq!(fixture.logged_changes(), logged);
    assert_clean(&fixture.hook(false).unwrap(), true);
}

/// A stored summary that no longer parses (a missing field) is treated as
/// absent: the hook rebuilds, serves the full result and stores a valid
/// summary that the following hook replays.
#[test]
fn an_unparsable_summary_is_rebuilt_not_replayed() {
    let mut fixture = Fixture::new();
    for seed in 1..=4 {
        fixture.append(seed);
    }
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.sql(&format!(
        "UPDATE mc_provider_policy_summaries_v1 SET summary_json=json_remove(summary_json,'$.hint') WHERE {}",
        fixture.mine()
    ));
    fixture.append(5);
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.append(6);
    assert_clean(&fixture.hook(false).unwrap(), true);
}

/// The first hook after an out-of-band write must rebuild (no stale replay)
/// and match the full computation, and after one more logged change the next
/// hook must replay the rebuilt summary exactly.
fn assert_write_rebuilds_then_replays(seed: u64, write: Op) {
    let mut fixture = Fixture::new();
    fixture.append(seed);
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.apply(&write);
    assert_clean(&fixture.hook(false).unwrap(), false);
    // A row still in the lineage: column moves detach a row or push its
    // ordinal past 1,000.
    fixture.update_one(
        seed,
        "lineage_id NOT LIKE 'detached%' AND ordinal < 1000",
        "policy_json=json_set(policy_json,'$.created_at_ms',7)",
    );
    assert_eq!(fixture.logged_changes(), 1);
    assert_clean(&fixture.hook(false).unwrap(), true);
}

fn assert_sequence_exact(ops: &[Op]) {
    let outcome = run(ops);
    assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
    assert!(
        outcome.replays > 0,
        "the sequence never replayed: {outcome:?}"
    );
    if let Some((at, what)) = outcome.mismatch {
        panic!("replay differs from the full computation at step {at}: {what}");
    }
}

/// The engine namespace decides which consumed tag numbers deactivate parts,
/// so it is part of the summary key: moving the conversation to a namespace
/// with other consumed numbers rebuilds instead of replaying (review F1).
#[test]
fn namespace_switch_is_seen_by_the_replay() {
    assert_write_rebuilds_then_replays(5683219820602439236, Op::Namespace(14771867209009316838));
}

/// Partner: consuming the same numbers in the conversation's own namespace is
/// logged by the consumed-tag trigger and replays exactly.
#[test]
fn consuming_the_same_numbers_in_the_own_namespace_replays_exactly() {
    let s = 14771867209009316838u64;
    assert_sequence_exact(&[
        Op::Append(5683219820602439236),
        Op::Hook,
        Op::Consume(s),
        Op::Consume(s / 5),
        Op::Consume(s / 25),
        Op::Hook,
    ]);
}

/// A row whose `kind` changes between header and non-header keeps its ordinal
/// and block index but moves every later non-header part one place in the
/// frozen-baseline order, so the replay falls back to a rebuild (review F2).
#[test]
fn kind_flip_is_seen_by_the_replay() {
    assert_write_rebuilds_then_replays(13707904503047187660, Op::KindFlip(8882675692618232619));
}

/// Partner: the same row changed in any other policy field replays exactly.
#[test]
fn changing_the_kind_flip_row_otherwise_replays_exactly() {
    let mut fixture = Fixture::new();
    fixture.append(13707904503047187660);
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.update_one(
        8882675692618232619,
        "json_extract(policy_json,'$.kind') IN ('text','header')",
        "policy_json=json_set(policy_json,'$.created_at_ms',7)",
    );
    assert_eq!(fixture.logged_changes(), 1);
    assert_clean(&fixture.hook(false).unwrap(), true);
}

/// A write that changes only the `ordinal` or `lineage_id` column moves the
/// row in or out of the effective lineage; a trigger drops the summary so the
/// next hook rebuilds (review F3).
#[test]
fn row_column_moves_are_seen_by_the_replay() {
    // Both column moves: the odd selector detaches the row to another lineage,
    // the even one moves its ordinal.
    for selector in [14493650589465211347, 14493650589465211346] {
        assert_write_rebuilds_then_replays(4091705870740682164, Op::OrdinalColumn(selector));
    }
}

/// Partner: the same row changed through `policy_json` is logged and replays.
#[test]
fn changing_the_moved_row_through_policy_json_replays_exactly() {
    let mut fixture = Fixture::new();
    fixture.append(4091705870740682164);
    assert_clean(&fixture.hook(false).unwrap(), false);
    fixture.update_one(
        14493650589465211347,
        "1",
        "policy_json=json_set(policy_json,'$.created_at_ms',7)",
    );
    assert_eq!(fixture.logged_changes(), 1);
    assert_clean(&fixture.hook(false).unwrap(), true);
}
