// Randomized tests of the signed-prefix hold in `apply_once` (`signed_prefix_hold`).
//
// An unfinished Anthropic thinking turn on a prefix-bound model signs its thinking against
// everything sent before it, so while such a turn is open a pass is held: it serves the
// previous messages unchanged and leaves queued work for the next real user message. The
// hold yields at the force band (usage at `force_materialize_percentage`, 85% for the 65%
// execute threshold) and on the 95% emergency. SOFT and HARD are the rewriting
// `PassPlan`s; SOFT+ is the response action of a Defer.
//
// A randomized multi-pass driver runs a session through tool steps, user turns, queued
// ctx_reduce drops, explicit flushes, execute-threshold crossings, historian publications,
// model switches (at user turns) and store reopens. On a prefix-bound model with signed
// thinking, every pass inside an open thinking turn below the 85% force band must replay
// the previously served messages unchanged and keep all queued work; the first pass after
// a real user message must apply all of it in one SOFT or HARD, and the pass after that
// must replay it. Sessions the hold never covers are digested and compared with golden
// digests recorded from the transform as it was before the hold existed.

const REVIEW_BOUND: &str = "anthropic/claude-opus-5-5";
const REVIEW_BOUND_ALT: &str = "anthropic/claude-sonnet-5-5";
const REVIEW_UNBOUND: &str = "anthropic/claude-opus-4-5";

struct ReviewRng(u64);

impl ReviewRng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }
}

fn review_reasoning(text: &str) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Reasoning {
        text: text.to_string(),
        signature: Some(format!("sig-{text}")),
    })
}

fn review_bytes(response: &TransformResponse) -> Vec<u8> {
    serde_json::to_vec(response.messages()).unwrap()
}

fn review_message_bytes(response: &TransformResponse) -> Vec<Vec<u8>> {
    response
        .messages()
        .iter()
        .map(|message| serde_json::to_vec(message).unwrap())
        .collect()
}

fn review_pending(s: &McStore, session: &str) -> BTreeSet<String> {
    s.load_pending_agent_drops(session)
        .unwrap()
        .into_iter()
        .map(|drop| drop.target_id)
        .collect()
}

fn review_edit_meta(s: &McStore, session: &str, edit: impl FnOnce(&mut ModuleMeta)) {
    let mut loaded = s.load(session).unwrap();
    edit(&mut loaded.meta);
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

/// One simulated session. `thinking` puts a signed reasoning block on every assistant
/// tool step; `turn_open` is true once the current user turn has such a step.
struct ReviewSession {
    dir: tempfile::TempDir,
    store: Option<McStore>,
    session: String,
    ctx: ProducerContext<'static>,
    messages: Vec<CkIngressMessage>,
    ordinal: u64,
    model: &'static str,
    thinking: bool,
    subagent: bool,
    used: u64,
    compartments: Vec<StoredCompartment>,
    /// Tool results of finished user turns: a historian may summarize up to them.
    closed_turn_ends: Vec<(u64, String)>,
    /// Every tool result served so far, as a drop target id.
    tool_results: Vec<String>,
    turn_open: bool,
}

impl ReviewSession {
    fn new(model: &'static str, thinking: bool, subagent: bool, label: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let session = format!("review-{label}");
        let compartments = vec![comp(1, 1, 1, "u1", "SUMMARY-1")];
        store.replace_compartments(&session, &compartments).unwrap();
        let messages = vec![
            item("u1", 1, "earlier task"),
            trailing_regression_assistant("a2", 2, None, false),
            item("u3", 3, "current task"),
        ];
        Self {
            dir,
            store: Some(store),
            session,
            ctx: pctx("git:proj", "/nonexistent-docs", 1_000),
            messages,
            ordinal: 3,
            model,
            thinking,
            subagent,
            used: 20_000,
            compartments,
            closed_turn_ends: vec![(2, "a2".to_string())],
            tool_results: Vec::new(),
            turn_open: false,
        }
    }

    fn s(&self) -> &McStore {
        self.store.as_ref().unwrap()
    }

    fn reopen(&mut self) {
        self.store = None;
        self.store = Some(store(self.dir.path()));
    }

    fn tool_step(&mut self) {
        self.ordinal += 1;
        let mid = format!("a{}", self.ordinal);
        let call = format!("t{}", self.ordinal);
        let mut assistant = assistant_tool_call(&mid, self.ordinal, &call);
        assistant.ck.content.insert(
            0,
            CkWireBlock::bare(ck_wire::CkKind::Text {
                text: format!("note {}", self.ordinal),
            }),
        );
        if self.thinking {
            assistant
                .ck
                .content
                .insert(0, review_reasoning(&format!("think {}", self.ordinal)));
            self.turn_open = true;
        }
        self.messages.push(assistant);
        self.ordinal += 1;
        let result = format!("r{}", self.ordinal);
        self.messages.push(tool_result(
            &result,
            self.ordinal,
            &call,
            &format!("output {} {}", self.ordinal, "x".repeat(400)),
        ));
        self.tool_results.push(format!("{result}#0"));
    }

    fn user_turn(&mut self) {
        let last = self.messages.last().unwrap();
        self.closed_turn_ends.push((last.ordinal, last.mid.clone()));
        self.ordinal += 1;
        self.messages.push(item(
            &format!("u{}", self.ordinal),
            self.ordinal,
            "continue",
        ));
        self.turn_open = false;
    }

    /// The historian summarizes through the end of a finished turn.
    fn publish(&mut self, rng: &mut ReviewRng) -> bool {
        let last_end = self.compartments.last().unwrap().end_message;
        let candidates: Vec<_> = self
            .closed_turn_ends
            .iter()
            .filter(|(ordinal, _)| *ordinal as i64 > last_end)
            .cloned()
            .collect();
        if candidates.is_empty() {
            return false;
        }
        let (ordinal, mid) = candidates[rng.below(candidates.len() as u64) as usize].clone();
        let seq = self.compartments.len() as i64 + 1;
        self.compartments.push(comp(
            seq,
            last_end + 1,
            ordinal as i64,
            &mid,
            &format!("SUMMARY-{seq}"),
        ));
        self.s()
            .replace_compartments(&self.session, &self.compartments)
            .unwrap();
        true
    }

    fn request(&self, recovery_armed: bool) -> TransformRequest {
        let mut request = with_usage(
            opencode_req(&self.session, "cfg0", self.messages.clone()),
            self.used,
            100_000,
        );
        request.provider_id = Some("anthropic".to_string());
        request.model_key = Some(self.model.to_string());
        request.is_subagent = self.subagent;
        request.emergency_recovery_armed = recovery_armed;
        request
    }

    fn run(&mut self, recovery_armed: bool) -> Result<TransformResponse, TransformError> {
        let request = self.request(recovery_armed);
        transform(self.s(), &request, &self.ctx)
    }

    /// Message id of the newest assistant step with reasoning in the open turn: every served
    /// block before it is covered by that signed thinking.
    fn last_kept_reasoning_mid(&self) -> Option<String> {
        if !self.turn_open {
            return None;
        }
        self.messages
            .iter()
            .rev()
            .take_while(|message| message.ck.role != "user")
            .find(|message| message.ck.content.iter().any(is_reasoning_block))
            .map(|message| message.mid.clone())
    }
}

/// Non-synthetic served messages up to (excluding) `mid`, keyed by harness id.
fn review_tail_before(response: &TransformResponse, mid: &str) -> Vec<(String, Vec<u8>)> {
    response
        .messages()
        .iter()
        .filter(|message| !message.meta.synthetic)
        .map(|message| {
            (
                message.meta.harness_id.clone().unwrap_or_default(),
                serde_json::to_vec(message).unwrap(),
            )
        })
        .take_while(|(id, _)| id != mid)
        .collect()
}

#[derive(Default, Debug)]
struct ReviewHeldStats {
    passes: usize,
    held: usize,
    releases: usize,
    releases_with_work: usize,
    pressure: usize,
    idle: usize,
    /// Labels of non-held passes inside an open turn whose synthetic head (the m0/m1
    /// history messages served before the conversation) changed. Recorded for inspection,
    /// not asserted: the force band and idle expiry currently allow it.
    in_turn_head_rewrites: Vec<String>,
}

/// Drives a prefix-bound session with signed thinking and checks the hold on every pass.
fn review_held_driver(
    seed: u64,
    model: &'static str,
    subagent: bool,
    steps: usize,
) -> ReviewHeldStats {
    let mut rng = ReviewRng(seed);
    let mut sim = ReviewSession::new(model, true, subagent, &format!("held-{seed}-{subagent}"));
    let mut stats = ReviewHeldStats::default();
    let mut previous: Option<TransformResponse> = None;
    let mut work_queued = false;
    let mut held_since_release = 0usize;
    let mut published_pending = false;
    for step in 0..steps {
        let mut recovery_armed = false;
        let mut idle = false;
        let mut pressure_used = None;
        let mut release = false;
        let mut switched = false;
        let event = rng.below(14);
        match event {
            0..=3 => sim.tool_step(),
            4 if !sim.tool_results.is_empty() => {
                let target =
                    sim.tool_results[rng.below(sim.tool_results.len() as u64) as usize].clone();
                sim.s()
                    .append_pending_agent_drops(&sim.session, &[target], 1)
                    .unwrap();
                work_queued = true;
            }
            5 if previous.is_some() => {
                review_edit_meta(sim.s(), &sim.session, |meta| {
                    meta.soft_refresh_pending = true
                });
                work_queued = true;
            }
            // Execute-threshold crossings, always below the 85% force band.
            6 => sim.used = 20_000 + rng.below(65) * 1_000,
            7 => {
                if sim.publish(&mut rng) {
                    work_queued = true;
                    published_pending = true;
                }
            }
            8 => sim.reopen(),
            9 if sim.turn_open && held_since_release > 0 => {
                // A model switch arrives with a new user message.
                if rng.below(2) == 0 {
                    switched = true;
                    sim.model = match sim.model {
                        REVIEW_BOUND => REVIEW_BOUND_ALT,
                        REVIEW_BOUND_ALT => REVIEW_BOUND,
                        other => other,
                    };
                }
                sim.user_turn();
                release = true;
            }
            10 if previous.is_some() && rng.below(3) == 0 => {
                pressure_used = Some(if rng.below(2) == 0 { 86_000 } else { 96_000 });
            }
            11 if previous.is_some() && rng.below(3) == 0 => recovery_armed = true,
            12 if previous.is_some() && rng.below(4) == 0 => idle = true,
            _ => sim.tool_step(),
        }
        if release && work_queued {
            // Make the releasing pass an execute pass. Queued drops alone never pay for a
            // rewrite (selection applies them only on a pass that already busts), so most
            // releases also carry a flush, as a user's /ctx-flush would.
            if sim.used < 66_000 {
                sim.used = 66_000 + rng.below(15) * 1_000;
            }
            if !published_pending && !switched && rng.below(3) != 0 {
                review_edit_meta(sim.s(), &sim.session, |meta| {
                    meta.soft_refresh_pending = true
                });
            }
        }
        let saved_used = sim.used;
        if let Some(used) = pressure_used {
            sim.used = used;
        }
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms);
            sim.ctx.now_ms += 10 * 60_000;
        }
        let pending_before = review_pending(sim.s(), &sim.session);
        let frozen_before = frozen_red_targets(&sim.s().load(&sim.session).unwrap().core);
        let flush_before = sim
            .s()
            .load(&sim.session)
            .unwrap()
            .meta
            .soft_refresh_pending;
        let initialized = sim.s().load(&sim.session).unwrap().meta.initialized;
        let bound = is_prefix_bound_thinking_model(Some(sim.model));
        let expect_held = sim.turn_open
            && bound
            && initialized
            && previous.is_some()
            && pressure_used.is_none()
            && !recovery_armed
            && !idle;
        let kept_mid = sim.last_kept_reasoning_mid();
        let response = sim
            .run(recovery_armed)
            .unwrap_or_else(|error| panic!("seed {seed} step {step}: transform failed: {error:?}"));
        stats.passes += 1;
        let pending_after = review_pending(sim.s(), &sim.session);
        let flush_after = sim
            .s()
            .load(&sim.session)
            .unwrap()
            .meta
            .soft_refresh_pending;
        let context = format!(
            "seed {seed} step {step} event {event} used {} model {} action {} reason {:?} scheduler {:?} pending {pending_before:?}->{pending_after:?} flush {flush_before}->{flush_after}",
            sim.used, sim.model, response.action, response.materialize_reason, response.scheduler_decision
        );
        if expect_held {
            stats.held += 1;
            held_since_release += 1;
            let prev = review_message_bytes(previous.as_ref().unwrap());
            let cur = review_message_bytes(&response);
            assert_eq!(
                response.action, "SOFT+",
                "{context}: a held pass is a Defer"
            );
            assert!(!response.prefix_bust_permitted, "{context}");
            assert!(
                cur.len() >= prev.len() && cur[..prev.len()] == prev[..],
                "{context}: a held pass replays the previous serve and only appends"
            );
            // A re-queued target that an earlier rewrite already dropped, or one a summary
            // already covers (no longer served), is retired from the queue on any pass; that
            // serves nothing new.
            let retired: BTreeSet<_> = pending_before.difference(&pending_after).cloned().collect();
            let served: BTreeSet<String> = previous
                .as_ref()
                .unwrap()
                .messages()
                .iter()
                .filter(|m| !m.meta.synthetic)
                .filter_map(|m| m.meta.harness_id.clone())
                .collect();
            assert!(
                retired.iter().all(|target| {
                    frozen_before.contains(target)
                        || !served.contains(target.split('#').next().unwrap())
                }),
                "{context}: queued drops stay queued (retired {retired:?})"
            );
            assert!(pending_after.is_subset(&pending_before), "{context}");
            assert_eq!(
                flush_before, flush_after,
                "{context}: a queued flush stays queued"
            );
        } else if let (true, Some(kept), Some(prev)) = (bound, kept_mid.as_ref(), previous.as_ref())
        {
            // An unheld pass inside the open turn (pressure, recovery, idle expiry): nothing
            // the turn's newest signed thinking covers may change.
            if pressure_used.is_some() || recovery_armed {
                stats.pressure += 1;
            }
            if idle {
                stats.idle += 1;
            }
            let kept_ordinal = sim
                .messages
                .iter()
                .find(|m| &m.mid == kept)
                .unwrap()
                .ordinal;
            for applied in pending_before
                .difference(&pending_after)
                .filter(|target| !frozen_before.contains(*target))
            {
                let mid = applied.split('#').next().unwrap();
                let ordinal = sim
                    .messages
                    .iter()
                    .find(|m| m.mid == mid)
                    .map_or(u64::MAX, |m| m.ordinal);
                assert!(
                    ordinal > kept_ordinal,
                    "{context}: drop {applied} before the kept signed thinking at {kept} was applied"
                );
            }
            let before_prev = review_tail_before(prev, kept);
            let before_cur = review_tail_before(&response, kept);
            let prev_ids: BTreeMap<_, _> = before_prev.into_iter().collect();
            for (id, bytes) in before_cur {
                if let Some(old) = prev_ids.get(&id) {
                    assert_eq!(
                        old, &bytes,
                        "{context}: served message {id} before the kept signed thinking changed"
                    );
                }
            }
            let head = |r: &TransformResponse| {
                r.messages()
                    .iter()
                    .filter(|m| m.meta.synthetic)
                    .map(|m| serde_json::to_vec(m).unwrap())
                    .collect::<Vec<_>>()
            };
            if head(prev) != head(&response) {
                stats.in_turn_head_rewrites.push(context.clone());
                published_pending = false;
            }
        }
        if !bound && sim.turn_open {
            held_since_release += 1;
        }
        if release && held_since_release > 0 {
            stats.releases += 1;
            // A queued flush, a pending historian publication or a model switch (which
            // forces a full rebuild) makes the release pass rewrite the prefix anyway, so
            // queued drops are applied with it.
            let ride = flush_before || published_pending || switched;
            if work_queued && ride {
                stats.releases_with_work += 1;
                assert!(
                    matches!(response.action.as_str(), "SOFT" | "HARD"),
                    "{context}: the first pass after the turn applies the held work"
                );
                assert!(
                    pending_after.is_empty(),
                    "{context}: every queued drop applied, left {pending_after:?}"
                );
                assert!(!flush_after, "{context}: the queued flush is consumed");
                published_pending = false;
            } else if work_queued {
                // No flush, publication or model switch rewrites the prefix on this pass.
                // Queued drops alone never open a rewrite (selection applies them only on a
                // pass that already rewrites), so they stay queued and the pass is a Defer.
                assert_eq!(response.action, "SOFT+", "{context}");
                assert_eq!(pending_before, pending_after, "{context}");
            }
            // The release rewrote once: sending the same request again must replay the
            // release's messages byte for byte instead of rewriting a second time.
            let again = sim.run(false).unwrap();
            stats.passes += 1;
            assert_eq!(again.action, "SOFT+", "{context}: one rewrite, not two");
            assert_eq!(review_bytes(&again), review_bytes(&response), "{context}");
            work_queued = !pending_after.is_empty() || flush_after || published_pending;
            held_since_release = 0;
        }
        if !expect_held && !release {
            if matches!(response.action.as_str(), "SOFT" | "HARD") {
                published_pending = false;
            }
            // Work may have been applied on a pressure or idle pass; it is no longer "held".
            work_queued = !pending_after.is_empty() || flush_after || published_pending;
        }
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms);
        }
        sim.used = saved_used;
        previous = Some(response);
    }
    stats
}

#[test]
fn review_signed_hold_randomized_driver_holds_then_releases_once() {
    let mut total = ReviewHeldStats::default();
    for (index, seed) in [
        0x9E37_79B9_7F4A_7C15u64,
        0xD1B5_4A32_D192_ED03,
        0x2545_F491_4F6C_DD1D,
        0xA076_1D64_78BD_642F,
        0xE703_7ED1_A0B4_28DB,
        0x8EBC_6AF0_9C88_C6E3,
    ]
    .into_iter()
    .enumerate()
    {
        let model = if index % 2 == 0 {
            REVIEW_BOUND
        } else {
            REVIEW_BOUND_ALT
        };
        let stats = review_held_driver(seed, model, false, 70);
        total.passes += stats.passes;
        total.held += stats.held;
        total.releases += stats.releases;
        total.releases_with_work += stats.releases_with_work;
        total.pressure += stats.pressure;
        total.idle += stats.idle;
        total
            .in_turn_head_rewrites
            .extend(stats.in_turn_head_rewrites);
    }
    eprintln!("signed-hold review driver: {total:#?}");
    assert!(total.held >= 150, "{total:?}");
    assert!(total.releases_with_work >= 6, "{total:?}");
}

/// Digest of every response and queue state over a seeded sequence for a session the hold
/// never covers (no thinking, or a model whose thinking is not prefix-bound). Covers tool
/// steps, user turns, queued drops, flushes, execute crossings, the force band, the 95%
/// emergency, overflow recovery, idle expiry, historian publications, model switches and
/// store reopens. Returns the digest and the number of transform passes it ran.
fn review_unheld_digest(
    model: &'static str,
    thinking: bool,
    subagent: bool,
    seed: u64,
) -> (String, usize) {
    use sha2::Digest as _;
    let mut rng = ReviewRng(seed);
    let mut sim = ReviewSession::new(
        model,
        thinking,
        subagent,
        &format!("unheld-{seed}-{thinking}-{subagent}"),
    );
    let mut hasher = sha2::Sha256::new();
    let mut passes = 0usize;
    for step in 0..62 {
        let mut recovery_armed = false;
        let mut idle = false;
        match rng.below(13) {
            0..=2 => sim.tool_step(),
            3 if !sim.tool_results.is_empty() => {
                let target =
                    sim.tool_results[rng.below(sim.tool_results.len() as u64) as usize].clone();
                sim.s()
                    .append_pending_agent_drops(&sim.session, &[target], 1)
                    .unwrap();
            }
            4 if step > 0 => {
                review_edit_meta(sim.s(), &sim.session, |meta| {
                    meta.soft_refresh_pending = true
                });
            }
            5 => sim.used = 20_000 + rng.below(78) * 1_000,
            6 if step > 0 && rng.below(2) == 0 => recovery_armed = true,
            7 if step > 0 && rng.below(2) == 0 => idle = true,
            8 => {
                sim.publish(&mut rng);
            }
            9 => sim.reopen(),
            10 => {
                if rng.below(3) == 0 {
                    sim.model = match sim.model {
                        REVIEW_UNBOUND => "anthropic/claude-sonnet-4-5",
                        "anthropic/claude-sonnet-4-5" => REVIEW_UNBOUND,
                        REVIEW_BOUND => REVIEW_BOUND_ALT,
                        _ => REVIEW_BOUND,
                    };
                }
                sim.user_turn();
            }
            _ => sim.tool_step(),
        }
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms);
            sim.ctx.now_ms += 10 * 60_000;
        }
        passes += 1;
        match sim.run(recovery_armed) {
            Ok(response) => {
                hasher.update(response.action.as_bytes());
                hasher.update(format!("{:?}", response.materialize_reason).as_bytes());
                hasher.update([u8::from(response.prefix_bust_permitted)]);
                hasher.update(review_bytes(&response));
            }
            Err(error) => hasher.update(format!("error: {error:?}").as_bytes()),
        }
        for target in review_pending(sim.s(), &sim.session) {
            hasher.update(target.as_bytes());
        }
        hasher.update([u8::from(
            sim.s()
                .load(&sim.session)
                .unwrap()
                .meta
                .soft_refresh_pending,
        )]);
        if idle {
            sim.ctx.observed_last_response_at_ms = Some(sim.ctx.now_ms);
        }
    }
    (format!("{:x}", hasher.finalize()), passes)
}

const REVIEW_UNHELD_CASES: [(&str, bool, bool); 6] = [
    (REVIEW_UNBOUND, true, false),
    (REVIEW_UNBOUND, true, true),
    (REVIEW_UNBOUND, false, false),
    (REVIEW_BOUND, false, false),
    (REVIEW_BOUND, false, true),
    (REVIEW_BOUND_ALT, false, false),
];

/// Pin the intended unheld-session output with distance-based age reclaim.
/// These snapshots retain current-task tool bodies; signed-prefix hold checks
/// remain independent of this unheld policy golden. Re-pinned for the TypeScript pass
/// decision rules. Cases 2, 3 and 5 first diverge from the earlier pins at steps 54, 58
/// and 10: each is the third consecutive primary execute pass (71%, 70% and 79%, below
/// the 85% force band) holding queued drops with no summary to wait for, which now
/// rebuilds and applies them (invariant 3's bounded execute exception). Every later step
/// follows from that rebuild. The subagent and unchanged primary cases never meet it.
const REVIEW_UNHELD_GOLDEN: [&str; 6] = [
    "379e07c15ef75bc0e0809bb4c4c9021b767fa988a0cf10d367635cb562e9c6d0",
    "a06635735bfd78bd1ed09d54c39a0c0e32c645ec6d4e1e6269c828b8358c7bdb",
    "0bc73213591876a39c00b3551741923697ff3eaa24fda6bb40a2e963ed690a53",
    "b60dbc9cc8e1034196ae139173033ea5e5d28c2bf289a80112b2874ee1ee354f",
    "e252f0b3697f7fc44ac5429fee0789a5f3f56b7462bec0cb6ad49468b2e22762",
    "cdbcf904ff6d9304115ad9ed2593a1d7ee09e5633205c83cfe3f203600319d5c",
];

#[test]
fn review_unheld_distance_policy_golden() {
    let mut actual = Vec::new();
    let mut passes = 0usize;
    for (index, (model, thinking, subagent)) in REVIEW_UNHELD_CASES.into_iter().enumerate() {
        let (digest, count) = review_unheld_digest(
            model,
            thinking,
            subagent,
            0x5851_F42D_4C95_7F2D ^ index as u64,
        );
        passes += count;
        actual.push(digest);
    }
    eprintln!("review unheld digests ({passes} passes): {actual:#?}");
    assert!(passes >= 300, "{passes}");
    assert_eq!(actual, REVIEW_UNHELD_GOLDEN, "digests: {actual:#?}");
}

/// The synthetic m0/m1 head of a serve.
fn review_head(response: &TransformResponse) -> Vec<Vec<u8>> {
    response
        .messages()
        .iter()
        .filter(|message| message.meta.synthetic)
        .map(|message| serde_json::to_vec(message).unwrap())
        .collect()
}

/// True when the served array still carries this signed reasoning block.
fn review_serves_signature(response: &TransformResponse, text: &str) -> bool {
    String::from_utf8(review_bytes(response))
        .unwrap()
        .contains(&format!("sig-{text}"))
}

/// A bootstrapped prefix-bound session inside an open thinking turn with three tool steps,
/// a historian publication of the finished earlier turn waiting in m1, and one held pass.
/// Returns the session and the held serve.
fn review_open_turn_with_publication(label: &str) -> (ReviewSession, TransformResponse) {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, label);
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let mut rng = ReviewRng(7);
    assert!(sim.publish(&mut rng), "the earlier turn can be summarized");
    sim.used = 66_000;
    let held = sim.run(false).unwrap();
    assert_eq!(
        held.action, "SOFT+",
        "the publication is held inside the turn"
    );
    (sim, held)
}

/// Strict prefix binding: a signed thinking
/// block stays valid only while everything before it is unchanged, and an m0/m1 re-render
/// invalidates every thinking block after it. An expired provider cache does not relax
/// that: the cached pair can still be replayed byte for byte. So an idle-expired pass
/// inside an open signed turn must not re-render m0/m1 while it still serves the turn's
/// signed thinking.
/// Runs one idle-expired pass inside the open turn and checks the property above.
/// `response_after_fold` places the provider's last response after the last HARD fold, the
/// usual case (the expiry is then also a priced HARD fold trigger, `idle_fold_due`). Without
/// it the expiry fold was already consumed, as on the resend after an aborted prepared fold.
fn review_check_idle_expiry_keeps_head(label: &str, response_after_fold: bool) {
    let (mut sim, held) = review_open_turn_with_publication(label);
    let kept = format!("think {}", sim.ordinal - 1);
    let last_response = sim.ctx.now_ms + i64::from(response_after_fold);
    sim.ctx.observed_last_response_at_ms = Some(last_response);
    sim.ctx.now_ms = last_response + 10 * 60_000;
    let expired = sim.run(false).unwrap();
    let rewrote_head = review_head(&expired) != review_head(&held);
    let kept_served = review_serves_signature(&expired, &kept);
    assert!(
        !(rewrote_head && kept_served),
        "action {} reason {:?}: m0/m1 changed while the turn's signed thinking ({kept}) is still served",
        expired.action,
        expired.materialize_reason
    );
}

#[test]
fn review_witness_idle_expiry_fold_rewrites_head_under_kept_signed_thinking() {
    review_check_idle_expiry_keeps_head("witness-idle-fold", true);
}

#[test]
fn review_witness_idle_expiry_resend_rewrites_head_under_kept_signed_thinking() {
    review_check_idle_expiry_keeps_head("witness-idle-resend", false);
}

/// Witness: an open signed turn must keep m0/m1 unchanged in the force band too (86% here).
/// The OpenCode TypeScript transform, the twin of this code, freezes m0/m1 for the whole
/// open turn (`freezeM0M1` in `transform-postprocess-phase.ts` has no force exception): at
/// 85% it applies queued drops but does not fold or refresh m0/m1.
#[test]
fn review_witness_force_band_rewrites_head_under_kept_signed_thinking() {
    let (mut sim, held) = review_open_turn_with_publication("witness-force");
    let kept = format!("think {}", sim.ordinal - 1);
    sim.used = 86_000;
    let forced = sim.run(false).unwrap();
    let rewrote_head = review_head(&forced) != review_head(&held);
    let kept_served = review_serves_signature(&forced, &kept);
    assert!(
        !(rewrote_head && kept_served),
        "action {} reason {:?}: m0/m1 changed while the turn's signed thinking ({kept}) is still served",
        forced.action,
        forced.materialize_reason
    );
}

/// A pass whose stored cache sections fail their digest check is always HARD, whatever is
/// queued (`cache_sections_discarded`, which also sets lineage `force_hard`). A queued drop
/// should be applied on that pass, as on every other HARD. Returns the response action and
/// the pending queue after the discarded-sections pass at `used`.
fn review_discarded_sections_pending(
    label: &str,
    thinking: bool,
    used: u64,
) -> (String, BTreeSet<String>) {
    let mut sim = ReviewSession::new(REVIEW_BOUND, thinking, false, label);
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    // The newest tool result: after the turn's last signed thinking, so thinking
    // protection never withholds it.
    let target = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[target], 1)
        .unwrap();
    corrupt_frozen_chunk(sim.dir.path(), &sim.session);
    sim.used = used;
    let rebuilt = sim.run(false).unwrap();
    assert_eq!(rebuilt.action, "HARD");
    assert_eq!(
        rebuilt.materialize_reason.as_deref(),
        Some("cache_sections_discarded")
    );
    (
        rebuilt.action.clone(),
        review_pending(sim.s(), &sim.session),
    )
}

/// Control: at 66% the scheduler executes, so selection runs and the drop rides the HARD.
#[test]
fn review_discarded_sections_hard_carries_a_drop_on_an_execute_pass() {
    let (_, pending) = review_discarded_sections_pending("discard-exec-plain", false, 66_000);
    assert!(pending.is_empty(), "left {pending:?}");
}

/// The same inside an open signed turn: the hold is lifted on this pass, and the newest
/// tool result (after the last signed thinking) rides the HARD.
#[test]
fn review_discarded_sections_hard_carries_a_drop_in_a_signed_turn() {
    let (_, pending) = review_discarded_sections_pending("discard-exec-signed", true, 66_000);
    assert!(pending.is_empty(), "left {pending:?}");
}

/// Witness of a gap. Below the execute threshold (here 20%) the scheduler defers, and
/// `producer_gate` then keeps reduction selection in its Defer class: the inputs it treats
/// as forcing a HARD are first render, render config, reconcile, priced HARD triggers and a
/// missing m1, and lineage `force_hard` (set by a lineage descent and by discarded
/// sections) is not among them. So the HARD still runs but applies none of the queued
/// drops, which then cost a second rewrite later.
#[test]
fn review_witness_discarded_sections_hard_drops_nothing_on_a_defer_pass() {
    let (_, plain) = review_discarded_sections_pending("discard-defer-plain", false, 20_000);
    let (_, signed) = review_discarded_sections_pending("discard-defer-signed", true, 20_000);
    assert!(
        plain.is_empty() && signed.is_empty(),
        "unprotected left {plain:?}; signed turn left {signed:?}"
    );
}

/// Witness: `render_config_changed` reaches `classify` without the hold's veto, and
/// `classify` (mc-core) returns HARD for it before it looks at `bust_opportunity`, the input
/// the hold clears. So a render-identity change inside a held turn still rewrites the
/// prefix, and the queued drop is not applied on that pass.
#[test]
fn review_witness_render_config_change_busts_a_held_pass() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "witness-render-config");
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let target = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[target], 1)
        .unwrap();
    sim.used = 66_000;
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+");
    let mut request = sim.request(false);
    request.render_config = "cfg1".to_string();
    let changed = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert_eq!(
        changed.action,
        "SOFT+",
        "reason {:?}, pending after {:?}",
        changed.materialize_reason,
        review_pending(sim.s(), &sim.session)
    );
}

/// A subagent's whole run is one signed turn: no real user message ends it, so below the
/// force band every pass is held. The hold must not strand it: the force band applies the
/// queued drop after the last signed thinking, and an idle-expired cache (the only other
/// unavoidable rewrite a subagent has) applies the next one. A drop before the kept signed
/// thinking stays queued throughout, as thinking protection requires.
#[test]
fn review_subagent_hold_is_released_by_the_force_band_and_idle_expiry() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, true, "subagent-release");
    sim.run(false).unwrap();
    sim.tool_step();
    sim.run(false).unwrap();
    let early = sim.tool_results[0].clone();
    sim.used = 70_000;
    let mut previous = sim.run(false).unwrap();
    for step in 0..6 {
        sim.tool_step();
        if step == 0 {
            sim.s()
                .append_pending_agent_drops(&sim.session, std::slice::from_ref(&early), 1)
                .unwrap();
        }
        let held = sim.run(false).unwrap();
        assert_eq!(held.action, "SOFT+", "step {step}");
        let prev = review_message_bytes(&previous);
        let cur = review_message_bytes(&held);
        assert!(
            cur[..prev.len()] == prev[..],
            "step {step}: held serve only appends"
        );
        previous = held;
    }
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, std::slice::from_ref(&late), 1)
        .unwrap();
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+");
    assert_eq!(
        review_pending(sim.s(), &sim.session),
        BTreeSet::from([early.clone(), late.clone()])
    );

    sim.used = 86_000;
    let forced = sim.run(false).unwrap();
    assert_eq!(
        review_pending(sim.s(), &sim.session),
        BTreeSet::from([early.clone()]),
        "force band: {} {:?}",
        forced.action,
        forced.materialize_reason
    );

    sim.used = 70_000;
    sim.tool_step();
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[late], 1)
        .unwrap();
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+");
    let last_response = sim.ctx.now_ms + 1;
    sim.ctx.observed_last_response_at_ms = Some(last_response);
    sim.ctx.now_ms = last_response + 10 * 60_000;
    let expired = sim.run(false).unwrap();
    assert_eq!(
        review_pending(sim.s(), &sim.session),
        BTreeSet::from([early]),
        "idle expiry: {} {:?}",
        expired.action,
        expired.materialize_reason
    );
}

/// For a subagent the hold is lifted by an idle-expired cache or by discarded cache
/// sections (subagents ignore lineage `force_hard`, so `signed_drains_released` names
/// `cache_sections_discarded` itself). When sections are discarded on a pass the scheduler
/// executes (66% usage), the forced HARD also applies the drop queued after the last signed
/// thinking, instead of leaving it for a turn end the subagent never reaches.
#[test]
fn review_subagent_discarded_sections_hard_carries_a_drop_in_a_signed_turn() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, true, "subagent-discard");
    sim.run(false).unwrap();
    for _ in 0..3 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    sim.used = 66_000;
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+", "the subagent is held at 66%");
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, &[late], 1)
        .unwrap();
    // A stray write to the frozen entry of the section index stands in for corruption: its
    // digest no longer matches, and the load discards the frozen list.
    let conn = rusqlite::Connection::open(sim.dir.path().join("store.db")).unwrap();
    let changed = conn
        .execute(
            "UPDATE mc_cache_state
                SET section_index = json_set(section_index, '$.f.h', '00000000000000000000000000000000')
              WHERE session_id = ?1",
            [sim.session.as_str()],
        )
        .unwrap();
    assert_eq!(changed, 1);
    drop(conn);
    let rebuilt = sim.run(false).unwrap();
    assert_eq!(rebuilt.action, "HARD");
    assert_eq!(
        rebuilt.materialize_reason.as_deref(),
        Some("cache_sections_discarded")
    );
    assert!(review_pending(sim.s(), &sim.session).is_empty());
}

/// A changed protection-floor input on a session without a floor snapshot asks for a HARD
/// (`pre_snapshot_inputs_changed`). The check remembers the inputs it sees, so it must not
/// run on a pass held inside a signed turn: the change would be recorded as seen while its
/// HARD is blocked, and the first pass after the turn would never issue that HARD.
#[test]
fn review_held_pass_keeps_a_changed_protection_floor_for_the_release() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "held-pre-snapshot");
    sim.run(false).unwrap();
    review_edit_meta(sim.s(), &sim.session, |meta| {
        meta.protected_tokens_effective = None;
    });
    // Observe the floor inputs once on a pass outside any signed turn.
    let observed = sim.run(false).unwrap();
    assert_eq!(observed.action, "SOFT+");
    for _ in 0..2 {
        sim.tool_step();
        let held = sim.run(false).unwrap();
        assert_eq!(held.action, "SOFT+");
    }
    sim.ctx.protected_tokens_floor = 24_000;
    let held = sim.run(false).unwrap();
    assert_eq!(held.action, "SOFT+", "{:?}", held.materialize_reason);
    assert!(
        sim.s()
            .load(&sim.session)
            .unwrap()
            .meta
            .protected_tokens_effective
            .is_none(),
        "a held pass takes no floor snapshot"
    );
    sim.user_turn();
    let released = sim.run(false).unwrap();
    assert_eq!(
        released.materialize_reason.as_deref(),
        Some("protected_tokens_inputs_changed"),
        "action {}",
        released.action
    );
}
