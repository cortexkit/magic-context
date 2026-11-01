// Signed-prefix hold. An unfinished Anthropic thinking turn on a prefix-bound model holds
// every pass below the force band (85% usage for the 65% execute threshold): whatever is
// queued (an explicit flush, ctx_reduce drops, a selected reduction, a pending HARD marker)
// stays queued, the pass (action "SOFT+", a Defer) serves the previous bytes, and the next
// real user message applies all of it in one rewrite. The force band and the 95% emergency
// still relieve pressure inside the turn, and a pass that must rewrite the prefix anyway
// applies the queued work too. Every case below queues one drop target before the turn's
// kept signed thinking (`old-answer#0`), which must stay untouched while the turn is open
// (editing it would invalidate the signed thinking after it), and one after it (`a2#0`),
// which any rewrite may apply.

const SIGNED_HOLD_MODEL: &str = "anthropic/claude-opus-5-5";
const SIGNED_HOLD_LATE_TARGET: &str = "a2#0";
const SIGNED_HOLD_EARLY_TARGET: &str = "old-answer#0";

fn signed_hold_reasoning(text: &str) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Reasoning {
        text: text.to_string(),
        signature: Some(format!("sig-{text}")),
    })
}

fn signed_hold_note(text: &str) -> CkWireBlock {
    CkWireBlock::bare(ck_wire::CkKind::Text {
        text: text.to_string(),
    })
}

/// A finished earlier turn, then an unfinished tool loop whose first step carries signed
/// thinking. `a2` has no thinking of its own, so its note follows the kept signed block.
fn signed_hold_messages() -> Vec<CkIngressMessage> {
    let mut a1 = assistant_tool_call("a1", 4, "t1");
    a1.ck.content.insert(0, signed_hold_reasoning("plan"));
    let mut a2 = assistant_tool_call("a2", 6, "t2");
    a2.ck
        .content
        .insert(0, signed_hold_note("progress note before the second read"));
    vec![
        item("old-prompt", 1, "earlier task"),
        trailing_regression_assistant("old-answer", 2, None, false),
        item("prompt", 3, "current task"),
        a1,
        tool_result("r1", 5, "t1", "first output"),
        a2,
        tool_result("r2", 7, "t2", "second output"),
    ]
}

fn signed_hold_request(session: &str, used: u64) -> TransformRequest {
    let mut request = with_usage(
        opencode_req(session, "cfg0", signed_hold_messages()),
        used,
        100_000,
    );
    request.provider_id = Some("anthropic".to_string());
    request.model_key = Some(SIGNED_HOLD_MODEL.to_string());
    request
}

/// Ends the tool loop: a real user message releases the signed-turn hold.
fn signed_hold_next_user(request: &mut TransformRequest) {
    request.messages.push(item("next-prompt", 8, "continue"));
}

fn signed_hold_bytes(response: &TransformResponse) -> Vec<u8> {
    serde_json::to_vec(&response.ck_messages).unwrap()
}

fn signed_hold_pending(s: &McStore, session: &str) -> BTreeSet<String> {
    s.load_pending_agent_drops(session)
        .unwrap()
        .into_iter()
        .map(|drop| drop.target_id)
        .collect()
}

fn signed_hold_queue_both(s: &McStore, session: &str) {
    s.append_pending_agent_drops(
        session,
        &[
            SIGNED_HOLD_LATE_TARGET.to_string(),
            SIGNED_HOLD_EARLY_TARGET.to_string(),
        ],
        1,
    )
    .unwrap();
}

fn signed_hold_edit_meta(s: &McStore, session: &str, edit: impl FnOnce(&mut ModuleMeta)) {
    let mut loaded = s.load(session).unwrap();
    edit(&mut loaded.meta);
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

/// The earlier prompt is summarized, so the session has a boundary a SOFT can splice onto.
fn signed_hold_compartments(s: &McStore, session: &str) {
    s.replace_compartments(session, &[comp(1, 1, 1, "old-prompt", "SUMMARY")])
        .unwrap();
}

/// Bootstraps the session inside the open turn and returns the steady-state serve at `used`.
fn signed_hold_baseline(s: &McStore, session: &str, used: u64) -> TransformResponse {
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    signed_hold_compartments(s, session);
    // Render the first head before the turn's signed thinking exists: a first render inside
    // the open turn would itself strip that thinking (see the rewrite tests below).
    let mut before_turn = signed_hold_request(session, 20_000);
    before_turn.messages.truncate(3);
    transform(s, &before_turn, &ctx).unwrap();
    transform(s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    let baseline = transform(s, &signed_hold_request(session, used), &ctx).unwrap();
    assert_eq!(
        baseline.action, "SOFT+",
        "the baseline itself must not rewrite"
    );
    baseline
}

/// The held pass must be a Defer that serves the previous bytes and consumes nothing.
fn assert_signed_hold_deferred(
    held: &TransformResponse,
    previous: &TransformResponse,
    s: &McStore,
    session: &str,
    expected_pending: usize,
) {
    assert_eq!(
        held.action, "SOFT+",
        "a held pass is a Defer (reason {:?})",
        held.materialize_reason
    );
    assert!(!held.prefix_bust_permitted);
    assert_eq!(signed_hold_bytes(held), signed_hold_bytes(previous));
    assert_eq!(signed_hold_pending(s, session).len(), expected_pending);
}

#[test]
fn signed_prefix_hold_defers_flush_and_queued_drops_to_the_next_user_turn() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-flush";
    // 66% is above the 65% execute threshold and below the 85% force band.
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_queue_both(&s, session);
    signed_hold_edit_meta(&s, session, |meta| meta.soft_refresh_pending = true);
    let mut request = signed_hold_request(session, 66_000);
    for _ in 0..2 {
        let held = transform(&s, &request, &ctx).unwrap();
        assert_signed_hold_deferred(&held, &baseline, &s, session, 2);
        assert!(s.load(session).unwrap().meta.soft_refresh_pending);
    }

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert!(
        matches!(applied.action.as_str(), "SOFT" | "HARD"),
        "the next user turn applies the held work: {}",
        applied.action
    );
    assert!(signed_hold_pending(&s, session).is_empty());
    assert!(!s.load(session).unwrap().meta.soft_refresh_pending);
    // One rewrite applied everything: the pass after it replays those bytes.
    let after = transform(&s, &request, &ctx).unwrap();
    assert_eq!(after.action, "SOFT+");
    assert_eq!(signed_hold_bytes(&after), signed_hold_bytes(&applied));
}

#[test]
fn signed_prefix_hold_keeps_a_selected_reduction_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = "signed-hold-reduction";
    let baseline = signed_hold_baseline(&s, session, 20_000);
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    // Inject one selected drop while nothing else on this pass rewrites the prefix; the
    // hold must keep it from opening a rewrite of its own.
    ctx.injected_reductions = vec![ReductionDecision {
        target_id: SIGNED_HOLD_LATE_TARGET.to_string(),
        kind: "drop".to_string(),
        payload: "[dropped while held]".to_string(),
    }];
    let mut request = signed_hold_request(session, 20_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 0);

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert_eq!(applied.action, "SOFT");
    assert!(String::from_utf8(signed_hold_bytes(&applied))
        .unwrap()
        .contains("[dropped while held]"));
}

#[test]
fn signed_prefix_hold_keeps_a_marker_hard_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-marker";
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_edit_meta(&s, session, |meta| meta.project_memory_epoch_pending = true);
    regate_mark_history_pending(&s, session);
    let mut request = signed_hold_request(session, 66_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 0);
    assert!(s.load(session).unwrap().meta.project_memory_epoch_pending);

    signed_hold_next_user(&mut request);
    let applied = transform(&s, &request, &ctx).unwrap();
    assert_eq!(applied.action, "HARD");
    assert!(!s.load(session).unwrap().meta.project_memory_epoch_pending);
}

#[test]
fn signed_prefix_hold_keeps_subagent_execute_drops_pending() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-subagent";
    signed_hold_compartments(&s, session);
    let subagent = |used: u64| {
        let mut request = signed_hold_request(session, used);
        request.is_subagent = true;
        request
    };
    transform(&s, &subagent(20_000), &ctx).unwrap();
    let baseline = transform(&s, &subagent(66_000), &ctx).unwrap();
    s.append_pending_agent_drops(session, &[SIGNED_HOLD_LATE_TARGET.to_string()], 1)
        .unwrap();
    let mut request = subagent(66_000);
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 1);

    signed_hold_next_user(&mut request);
    transform(&s, &request, &ctx).unwrap();
    assert!(signed_hold_pending(&s, session).is_empty());
}

/// The synthetic m0/m1 head of a serve (and any synthetic todo pair).
fn signed_hold_head(response: &TransformResponse) -> Vec<Vec<u8>> {
    response
        .messages()
        .iter()
        .filter(|message| message.meta.synthetic)
        .map(|message| serde_json::to_vec(message).unwrap())
        .collect()
}

/// Context-pressure relief inside the open turn, with both drops from
/// `signed_hold_queue_both` queued. The late drop (after the kept signed thinking) is applied
/// and the serve shrinks; the early drop, before it, stays withheld. The m0/m1 head replays byte
/// for byte while that signed thinking is still served, so a pending structural history marker
/// (a HARD fold trigger) waits for the next user turn, which then takes it.
fn check_signed_hold_relief(session: &str, used: u64, recovery_armed: bool) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let baseline = signed_hold_baseline(&s, session, 20_000);
    signed_hold_queue_both(&s, session);
    signed_hold_edit_meta(&s, session, |meta| meta.project_memory_epoch_pending = true);
    regate_mark_history_pending(&s, session);
    let mut request = signed_hold_request(session, used);
    request.emergency_recovery_armed = recovery_armed;
    let relieved = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
        "{session}: only the drop before the kept signed thinking waits ({})",
        relieved.action
    );
    assert_eq!(
        relieved.action, "SOFT",
        "{session}: {:?}",
        relieved.materialize_reason
    );
    assert_eq!(signed_hold_head(&relieved), signed_hold_head(&baseline));
    assert!(
        signed_hold_bytes(&relieved).len() < signed_hold_bytes(&baseline).len(),
        "{session}: the drop shrinks the serve"
    );
    assert!(s.load(session).unwrap().meta.project_memory_epoch_pending);

    request.emergency_recovery_armed = false;
    signed_hold_next_user(&mut request);
    let released = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        released.action, "HARD",
        "{session}: the marker lands after the turn"
    );
    assert!(!s.load(session).unwrap().meta.project_memory_epoch_pending);
}

/// 86% is at or above the force band (85% for the 65% execute threshold).
#[test]
fn signed_prefix_hold_yields_to_the_force_band() {
    check_signed_hold_relief("signed-hold-force", 86_000, false);
}

#[test]
fn signed_prefix_hold_yields_to_the_95_percent_emergency() {
    check_signed_hold_relief("signed-hold-emergency", 95_000, false);
}

/// A provider already rejected this session's wire as too long, so the scheduler makes the
/// pass a 95% emergency (`PassDecision::Emergency95`) even though local usage reads 30%,
/// below the force band. The hold must yield to it exactly as it does at 95% usage.
#[test]
fn signed_prefix_hold_yields_to_an_armed_overflow_recovery() {
    check_signed_hold_relief("signed-hold-recovery", 30_000, true);
}

/// The same armed recovery for a subagent, whose only permission to apply a queued drop is
/// a scheduler decision that the hold would otherwise withhold.
#[test]
fn signed_prefix_hold_subagent_yields_to_an_armed_overflow_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-subagent-recovery";
    signed_hold_compartments(&s, session);
    let subagent = |used: u64, armed: bool| {
        let mut request = signed_hold_request(session, used);
        request.is_subagent = true;
        request.emergency_recovery_armed = armed;
        request
    };
    transform(&s, &subagent(20_000, false), &ctx).unwrap();
    s.append_pending_agent_drops(session, &[SIGNED_HOLD_LATE_TARGET.to_string()], 1)
        .unwrap();
    let held = transform(&s, &subagent(30_000, false), &ctx).unwrap();
    assert_eq!(held.action, "SOFT+");
    assert_eq!(signed_hold_pending(&s, session).len(), 1);
    let relieved = transform(&s, &subagent(30_000, true), &ctx).unwrap();
    assert!(
        signed_hold_pending(&s, session).is_empty(),
        "{} {:?}",
        relieved.action,
        relieved.materialize_reason
    );
}

/// A pass that rebuilds the m0/m1 head changes the bytes every signed thinking block after
/// it is bound to, so it strips every signed block (the active turn's included) and reports
/// `signed_thinking_reset`. With no signed thinking left to protect, both queued drops are
/// applied, including `old-answer#0` before the previously kept thinking. The next pass
/// replays the persisted strip unchanged.
fn assert_signed_hold_reset(
    s: &McStore,
    session: &str,
    request: &TransformRequest,
    ctx: &ProducerContext<'_>,
    rewritten: &TransformResponse,
) {
    assert_eq!(rewritten.action, "HARD", "{session}");
    assert!(rewritten.signed_thinking_reset, "{session}");
    assert!(
        signed_hold_pending(s, session).is_empty(),
        "{session}: every queued drop lands on the rewrite"
    );
    let served = String::from_utf8(signed_hold_bytes(rewritten)).unwrap();
    assert!(!served.contains("sig-plan"), "{session}: {served}");
    let replay = transform(s, request, ctx).unwrap();
    assert_eq!(replay.action, "SOFT+", "{session}");
    assert!(!replay.signed_thinking_reset);
    assert_eq!(signed_hold_bytes(&replay), signed_hold_bytes(rewritten));
}

/// `prepare` edits the stored state of a bootstrapped session so its m0/m1 head cannot be
/// replayed (for example, by deleting the frozen m1 unit), forcing a HARD rebuild. The reset
/// follows the served head bytes: it happens exactly when the rebuilt head differs from the
/// head last served. `expect_reset` pins which of the two a case must take.
fn check_signed_hold_rides_unavoidable_rewrite(
    session: &str,
    expect_reset: Option<bool>,
    prepare: impl FnOnce(&McStore, &mut ProducerContext<'static>),
) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let baseline = signed_hold_baseline(&s, session, 20_000);
    assert!(String::from_utf8(signed_hold_bytes(&baseline))
        .unwrap()
        .contains("sig-plan"));
    prepare(&s, &mut ctx);
    signed_hold_queue_both(&s, session);
    let request = signed_hold_request(session, 20_000);
    let rewritten = transform(&s, &request, &ctx).unwrap();
    let head_changed = signed_hold_head(&rewritten) != signed_hold_head(&baseline);
    assert_eq!(
        rewritten.signed_thinking_reset, head_changed,
        "{session}: the reset follows the served head bytes"
    );
    if let Some(expected) = expect_reset {
        assert_eq!(rewritten.signed_thinking_reset, expected, "{session}");
    }
    if rewritten.signed_thinking_reset {
        assert_signed_hold_reset(&s, session, &request, &ctx, &rewritten);
    } else {
        // An identical rebuild leaves the kept signed thinking valid: it stays, and only
        // the drop after it lands.
        assert_eq!(rewritten.action, "HARD", "{session}");
        assert_eq!(
            signed_hold_pending(&s, session),
            BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
            "{session}"
        );
        assert!(String::from_utf8(signed_hold_bytes(&rewritten))
            .unwrap()
            .contains("sig-plan"));
    }
}

#[test]
fn signed_prefix_hold_first_render_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-first-render";
    signed_hold_compartments(&s, session);
    signed_hold_queue_both(&s, session);
    let request = signed_hold_request(session, 20_000);
    let first = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_reset(&s, session, &request, &ctx, &first);
}

fn signed_hold_delete_m1(s: &McStore, session: &str) {
    let mut loaded = s.load(session).unwrap();
    loaded.core.frozen_units.retain(|unit| unit.key != "m1");
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
}

/// Losing the cached m1 alone is no head change: the rebuild serves the same head bytes as
/// the last serve, so the kept signed thinking stays.
#[test]
fn signed_prefix_hold_missing_m1_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-missing-m1", Some(false), |s, _| {
        signed_hold_delete_m1(s, "signed-hold-missing-m1");
    });
}

/// With a historian publication waiting, the rebuilt head folds it in, so its bytes differ
/// from the last serve and the turn's signed thinking is reset.
#[test]
fn signed_prefix_hold_missing_m1_with_a_publication_resets() {
    check_signed_hold_rides_unavoidable_rewrite(
        "signed-hold-missing-m1-published",
        Some(true),
        |s, _| {
            let session = "signed-hold-missing-m1-published";
            s.replace_compartments(
                session,
                &[
                    comp(1, 1, 1, "old-prompt", "SUMMARY"),
                    comp(2, 2, 2, "old-answer", "PUBLISHED"),
                ],
            )
            .unwrap();
            signed_hold_delete_m1(s, session);
        },
    );
}

/// A lineage descent onto a new host conversation epoch serves a different message array
/// and rebuilds the m0/m1 head (a HARD), so the turn's signed thinking is stripped and the
/// queued drops all land on that pass.
#[test]
fn signed_prefix_hold_lineage_descent_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let prior = "signed-hold-prior";
    let session = "signed-hold-descent";
    seed_fake_compaction_prior(&s, prior);
    signed_hold_queue_both(&s, session);
    let mut request = signed_hold_request(session, 20_000);
    // The host compacted the earlier turn into a continuation summary on the new epoch.
    let summary = continuation_summary("held turn");
    request.messages[0] = wire_item(
        "user",
        "old-prompt",
        1,
        &[
            "<system-reminder>Today's date: 2026-08-06</system-reminder>",
            &summary,
        ],
    );
    request.compaction_observed = true;
    request.lineage_switched = true;
    request.descent_edge_id = 7;
    request.prior_conversation_key = prior.to_string();
    request.prior_epoch = 1;
    request.new_epoch = 2;
    request.constituents = vec![(prior.to_string(), session.to_string(), 2)];
    let descended = transform(&s, &request, &ctx).unwrap();
    assert!(
        signed_hold_pending(&s, session).is_empty(),
        "every queued drop lands on the descent ({} {:?})",
        descended.action,
        descended.materialize_reason
    );
    assert_eq!(descended.action, "HARD");
    assert_eq!(
        descended.materialize_reason.as_deref(),
        Some("lineage_descent")
    );
    assert!(descended.signed_thinking_reset);
    assert!(!String::from_utf8(signed_hold_bytes(&descended))
        .unwrap()
        .contains("sig-plan"));
}

/// An expired provider cache does not let the head change: the cached m0/m1 pair can still
/// be replayed, and re-rendering it would invalidate the turn's kept signed thinking. The
/// pass is a full cache write anyway, so the late drop queued by `signed_hold_queue_both` is
/// applied in it; the head replays unchanged, and the early drop (before the kept signed
/// thinking) stays pending.
#[test]
fn signed_prefix_hold_idle_expiry_replays_the_head_and_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = "signed-hold-idle";
    let baseline = signed_hold_baseline(&s, session, 20_000);
    signed_hold_queue_both(&s, session);
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    // The last response landed well over the 5m cache TTL ago.
    ctx.observed_last_response_at_ms = Some(1_000);
    ctx.now_ms = 1_000 + 10 * 60_000;
    let expired = transform(&s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()]),
        "the late drop rides the expired pass ({} {:?})",
        expired.action,
        expired.materialize_reason
    );
    assert_eq!(expired.action, "SOFT");
    assert_eq!(signed_hold_head(&expired), signed_hold_head(&baseline));
}

/// A pending bootstrap-seed fold makes the pass a HARD (a full m0/m1 rebuild), so queued
/// work is applied on it. Here the
/// rebuilt head is byte-identical to the one already served, so nothing before the kept
/// signed thinking changed: the thinking stays, and only the drop after it lands. The reset
/// follows changed head bytes, not the HARD itself.
#[test]
fn signed_prefix_hold_bootstrap_seed_fold_carries_queued_drops() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-seed";
    let baseline = signed_hold_baseline(&s, session, 20_000);
    signed_hold_edit_meta(&s, session, |meta| {
        meta.bootstrap_seed_fold_pending = true;
        meta.soft_refresh_pending = true;
    });
    signed_hold_queue_both(&s, session);
    let rebuilt = transform(&s, &signed_hold_request(session, 20_000), &ctx).unwrap();
    assert_eq!(rebuilt.action, "HARD");
    assert!(!rebuilt.signed_thinking_reset);
    assert_eq!(signed_hold_head(&rebuilt), signed_hold_head(&baseline));
    assert_eq!(
        signed_hold_pending(&s, session),
        BTreeSet::from([SIGNED_HOLD_EARLY_TARGET.to_string()])
    );
    assert!(String::from_utf8(signed_hold_bytes(&rebuilt))
        .unwrap()
        .contains("sig-plan"));
}

#[test]
fn signed_prefix_hold_legacy_baseline_migration_carries_queued_drops() {
    check_signed_hold_rides_unavoidable_rewrite("signed-hold-legacy", None, |s, _| {
        let session = "signed-hold-legacy";
        let mut loaded = s.load(session).unwrap();
        loaded.core.frozen_units = vec![synth_region("baseline", "OLD".into())];
        loaded.core.pending_changes.clear();
        loaded.meta.soft_refresh_pending = true;
        s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
            .unwrap();
    });
}

/// Seeded xorshift so the differential sequence is reproducible without a dependency.
struct SignedHoldRng(u64);

impl SignedHoldRng {
    fn below(&mut self, bound: u64) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0 % bound
    }
}

/// Digest of every response and queue state over a seeded sequence of tool steps, user
/// turns, queued drops, flushes, usage swings, overflow recoveries and idle gaps. The
/// sessions here never hold (no thinking, or a model whose thinking is not prefix-bound).
fn signed_hold_differential_digest(
    model: &str,
    thinking: bool,
    subagent: bool,
    seed: u64,
) -> String {
    use sha2::Digest as _;
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let session = format!("signed-hold-diff-{seed}-{thinking}-{subagent}");
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let mut rng = SignedHoldRng(seed);
    s.replace_compartments(&session, &[comp(1, 1, 1, "u1", "SUMMARY")])
        .unwrap();
    let mut messages = vec![item("u1", 1, "task")];
    let mut droppable = Vec::new();
    let mut ordinal = 1u64;
    let mut used = 20_000u64;
    let mut hasher = sha2::Sha256::new();
    for step in 0..28 {
        let mut recovery_armed = false;
        let mut idle = false;
        match rng.below(8) {
            0 | 1 => {
                ordinal += 1;
                let mid = format!("a{ordinal}");
                let call = format!("t{ordinal}");
                let mut assistant = assistant_tool_call(&mid, ordinal, &call);
                assistant
                    .ck
                    .content
                    .insert(0, signed_hold_note(&format!("note {ordinal}")));
                let note_index = if thinking {
                    assistant
                        .ck
                        .content
                        .insert(0, signed_hold_reasoning(&format!("think {ordinal}")));
                    1
                } else {
                    0
                };
                droppable.push(format!("{mid}#{note_index}"));
                messages.push(assistant);
                ordinal += 1;
                messages.push(tool_result(
                    &format!("r{ordinal}"),
                    ordinal,
                    &call,
                    &format!("output {ordinal}"),
                ));
            }
            2 => {
                ordinal += 1;
                let mid = format!("u{ordinal}");
                droppable.push(format!("{mid}#0"));
                messages.push(item(&mid, ordinal, "next step"));
            }
            3 if !droppable.is_empty() => {
                let target = droppable[rng.below(droppable.len() as u64) as usize].clone();
                s.append_pending_agent_drops(&session, &[target], 1)
                    .unwrap();
            }
            4 if step > 0 => {
                signed_hold_edit_meta(&s, &session, |meta| meta.soft_refresh_pending = true);
            }
            5 => used = 20_000 + rng.below(78) * 1_000,
            6 => recovery_armed = true,
            7 => idle = true,
            _ => {}
        }
        if idle {
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
            ctx.now_ms += 10 * 60_000;
        }
        let mut request = with_usage(
            opencode_req(&session, "cfg0", messages.clone()),
            used,
            100_000,
        );
        request.provider_id = Some("anthropic".to_string());
        request.model_key = Some(model.to_string());
        request.is_subagent = subagent;
        request.emergency_recovery_armed = recovery_armed;
        match transform(&s, &request, &ctx) {
            Ok(response) => {
                hasher.update(response.action.as_bytes());
                hasher.update(format!("{:?}", response.materialize_reason).as_bytes());
                hasher.update([u8::from(response.prefix_bust_permitted)]);
                hasher.update(signed_hold_bytes(&response));
            }
            Err(error) => hasher.update(format!("error: {error:?}").as_bytes()),
        }
        for target in signed_hold_pending(&s, &session) {
            hasher.update(target.as_bytes());
        }
        if idle {
            // The provider answered the resend, so the next step is warm again.
            ctx.observed_last_response_at_ms = Some(ctx.now_ms);
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Pin sessions outside the signed-prefix hold under distance-based age reclaim.
/// Their output intentionally retains more current-task bodies than the former
/// rebuild-count policy. Regenerate these digests only for an intended change
/// to unheld sessions; the signed-prefix invariants are tested separately.
#[test]
fn signed_prefix_hold_unheld_distance_policy_golden() {
    let cases = [
        ("anthropic/claude-opus-4-5", true, false),
        ("anthropic/claude-opus-4-5", true, true),
        (SIGNED_HOLD_MODEL, false, false),
        (SIGNED_HOLD_MODEL, false, true),
    ];
    let golden: [&str; 4] = [
        "25bbe1a8b56991017ff6373fbade8b5569f4b364eafcf5aeaaf5c89a3c13c2859d120561c64defb7098a2d980e22d2b0df97567815660608a513b85e4e1dc46c",
        "39de76c542bfe5d3568981efa76ae765a5ddd39e0565626e17873e74fc371cadeabce589701cab5b9ee0f0264a1f8d3ff1404cfaa2f2cf21b525fa3dc0a1a62b",
        "b29fdfa0ca15e5b1f6a3eca9381d0ef47ed04e400c3f1eef75fc69343418fc91fc5c37fd05c42358237c4b3679278aa84445a057c2e82da207e486a39f14726c",
        "cf5dfef42cf7ee578c19bdc383b681bdaa841a3a7be088ad130652ab4bd061a1fef456a60bac4dd8e8a7676ca5f048826783f3dbb4e03c0257feb2234a1fce39",
    ];
    let mut actual = Vec::new();
    for (model, thinking, subagent) in cases {
        let mut combined = String::new();
        for seed in [0x9E37_79B9_7F4A_7C15u64, 0xD1B5_4A32_D192_ED03] {
            combined.push_str(&signed_hold_differential_digest(
                model, thinking, subagent, seed,
            ));
        }
        actual.push(combined);
    }
    // Deterministic: a second run of one case reproduces its digest.
    assert_eq!(
        signed_hold_differential_digest(cases[0].0, cases[0].1, cases[0].2, 0x9E37_79B9_7F4A_7C15),
        actual[0][..64]
    );
    assert_eq!(actual, golden, "digests: {actual:#?}");
}

/// A render-identity change inside the open turn would re-render m0/m1 under the kept signed
/// thinking, so it waits like any other head rebuild; the first pass after the turn takes it
/// as a HARD and carries the queued work.
#[test]
fn signed_prefix_hold_render_identity_change_waits_for_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-render-identity";
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_queue_both(&s, session);
    let mut request = signed_hold_request(session, 66_000);
    request.render_config = "cfg1".to_string();
    let held = transform(&s, &request, &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 2);

    signed_hold_next_user(&mut request);
    let released = transform(&s, &request, &ctx).unwrap();
    assert_eq!(released.action, "HARD");
    assert_eq!(released.materialize_reason.as_deref(), Some("epoch_change"));
    assert!(signed_hold_pending(&s, session).is_empty());
}

/// A reconcile pending with its boundary absent from the live array (a revert removed it)
/// makes `classify` ask for a reconcile HARD. Inside the open turn that would re-render
/// m0/m1 under the kept signed thinking, so the pass defers and keeps the reconcile flag; the
/// first pass after the turn takes the HARD and carries the queued work.
#[test]
fn signed_prefix_hold_reconcile_hard_waits_for_the_turn() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-reconcile";
    let baseline = signed_hold_baseline(&s, session, 66_000);
    signed_hold_queue_both(&s, session);
    // Stand in for the revert: the stored boundary names a block no longer in the request.
    let mut loaded = s.load(session).unwrap();
    loaded.core.boundary_id = "reverted#0".to_string();
    loaded.core.reconcile_pending = true;
    s.commit(session, loaded.row_version, &loaded.core, &loaded.meta)
        .unwrap();
    let mut request = signed_hold_request(session, 66_000);
    for _ in 0..2 {
        let held = transform(&s, &request, &ctx).unwrap();
        assert_signed_hold_deferred(&held, &baseline, &s, session, 2);
        assert!(s.load(session).unwrap().core.reconcile_pending);
    }

    signed_hold_next_user(&mut request);
    let released = transform(&s, &request, &ctx).unwrap();
    // The stand-in boundary is also detected as a boundary divergence, whose recut forces a
    // HARD too and names it, so only the action is asserted.
    assert_eq!(released.action, "HARD", "{:?}", released.materialize_reason);
    assert!(signed_hold_pending(&s, session).is_empty());
}

/// Turning the tag surface on (the request's `tool_present`) adds tags to a subagent's
/// existing blocks, including those before its kept signed thinking. A held subagent therefore
/// defers the transition until the hold lifts, then applies it in one SOFT pass.
#[test]
fn signed_prefix_hold_subagent_tag_surface_transition_waits() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
    ctx.signed_thinking_hold = crate::config::SignedThinkingHold::On;
    let session = "signed-hold-subagent-surface";
    signed_hold_compartments(&s, session);
    let subagent = |used: u64, tools: bool| {
        let mut request = signed_hold_request(session, used);
        request.is_subagent = true;
        request.tool_present = tools;
        request
    };
    transform(&s, &subagent(20_000, false), &ctx).unwrap();
    let baseline = transform(&s, &subagent(66_000, false), &ctx).unwrap();
    assert_eq!(baseline.action, "SOFT+");
    for _ in 0..2 {
        let held = transform(&s, &subagent(66_000, true), &ctx).unwrap();
        assert_signed_hold_deferred(&held, &baseline, &s, session, 0);
        assert!(!s.load(session).unwrap().meta.tagging_surface_active);
    }
    let released = transform(&s, &subagent(86_000, true), &ctx).unwrap();
    assert_eq!(released.action, "SOFT");
    assert!(s.load(session).unwrap().meta.tagging_surface_active);
    // The force band lifts the hold but does not strip the turn's signed thinking: the
    // transition tags only blocks after the kept signed block; a provider that binds signed
    // thinking to the bytes before it accepts edits after it.
    // Everything up to and including that block is byte-identical to the held serve.
    let flat = |response: &TransformResponse| -> Vec<Value> {
        response
            .ck_messages
            .iter()
            .flatten()
            .flat_map(|served| {
                served.message.content.iter().map(|block| {
                    serde_json::json!([
                        served.message.role,
                        serde_json::to_value(&block.kind).unwrap()
                    ])
                })
            })
            .collect()
    };
    let signed_at = |blocks: &[Value]| {
        blocks
            .iter()
            .position(|block| block.to_string().contains("sig-plan"))
            .expect("the turn's signed thinking is still served")
    };
    let (held_blocks, released_blocks) = (flat(&baseline), flat(&released));
    let kept = signed_at(&released_blocks);
    assert!(!released.signed_thinking_reset);
    assert_eq!(kept, signed_at(&held_blocks));
    assert_eq!(released_blocks[..=kept], held_blocks[..=kept]);
    assert_eq!(released_blocks.len(), held_blocks.len());
    let changed = (0..released_blocks.len())
        .filter(|&index| released_blocks[index] != held_blocks[index])
        .collect::<Vec<_>>();
    assert!(!changed.is_empty(), "the transition tags something");
    assert!(changed
        .iter()
        .all(|&index| index > kept && released_blocks[index].to_string().contains('§')));
}

/// Expected behaviour once the signed-thinking hold setting is on: edit admission keeps a
/// subagent's tag-surface transition pending for the whole open signed turn, even in the
/// force band, so the surface is introduced in one rewrite after the next user message.
/// Ignored for now: with the setting off, the always-on signed-prefix hold above spends the
/// transition in the force band. This test activates with the signed-thinking hold setting.
#[test]
#[ignore = "activates with the signed-thinking hold setting"]
fn signed_prefix_hold_setting_keeps_subagent_surface_transition_until_user_turn() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let session = "signed-hold-setting-subagent-surface";
    signed_hold_compartments(&s, session);
    let subagent = |used: u64, tools: bool| {
        let mut request = signed_hold_request(session, used);
        request.is_subagent = true;
        request.tool_present = tools;
        request
    };
    transform(&s, &subagent(20_000, false), &ctx).unwrap();
    let baseline = transform(&s, &subagent(66_000, false), &ctx).unwrap();
    assert_eq!(baseline.action, "SOFT+");
    let held = transform(&s, &subagent(86_000, true), &ctx).unwrap();
    assert_signed_hold_deferred(&held, &baseline, &s, session, 0);
    assert!(!s.load(session).unwrap().meta.tagging_surface_active);
    let mut next = subagent(86_000, true);
    signed_hold_next_user(&mut next);
    let released = transform(&s, &next, &ctx).unwrap();
    assert_eq!(released.action, "SOFT");
    assert!(s.load(session).unwrap().meta.tagging_surface_active);
}

/// In the force band a queued drop after the kept signed thinking is applied, but the
/// m0/m1 head replays unchanged: the historian publication waiting for m1 is not composed
/// into it, and an explicit flush stays pending for its m1 refresh. The first pass after
/// the turn publishes and clears the flush. (Uses the review driver's session fixture.)
#[test]
fn signed_prefix_hold_force_band_drains_without_touching_the_head() {
    let (mut sim, held) = review_open_turn_with_publication("hold-force-drain");
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, std::slice::from_ref(&late), 1)
        .unwrap();
    review_edit_meta(sim.s(), &sim.session, |meta| {
        meta.soft_refresh_pending = true
    });
    sim.used = 86_000;
    let forced = sim.run(false).unwrap();
    assert_eq!(forced.action, "SOFT", "{:?}", forced.materialize_reason);
    assert!(review_pending(sim.s(), &sim.session).is_empty());
    assert_eq!(review_head(&forced), review_head(&held));
    assert!(!String::from_utf8(review_bytes(&forced))
        .unwrap()
        .contains("SUMMARY-2"));
    assert!(
        sim.s()
            .load(&sim.session)
            .unwrap()
            .meta
            .soft_refresh_pending
    );

    sim.user_turn();
    sim.used = 66_000;
    let released = sim.run(false).unwrap();
    assert!(
        matches!(released.action.as_str(), "SOFT" | "HARD"),
        "{}",
        released.action
    );
    assert!(String::from_utf8(review_bytes(&released))
        .unwrap()
        .contains("SUMMARY-2"));
    assert!(
        !sim.s()
            .load(&sim.session)
            .unwrap()
            .meta
            .soft_refresh_pending
    );
}

/// An idle-expired pass with nothing queued and only an m1 delta waiting (a historian
/// publication) does not rewrite anything: the delta waits with the frozen head, so the
/// pass replays the previous serve.
#[test]
fn signed_prefix_hold_idle_expiry_with_only_an_m1_delta_replays() {
    let (mut sim, held) = review_open_turn_with_publication("hold-idle-m1-delta");
    let last_response = sim.ctx.now_ms + 1;
    sim.ctx.observed_last_response_at_ms = Some(last_response);
    sim.ctx.now_ms = last_response + 10 * 60_000;
    let expired = sim.run(false).unwrap();
    assert_eq!(expired.action, "SOFT+", "{:?}", expired.materialize_reason);
    assert_eq!(review_bytes(&expired), review_bytes(&held));
}

/// At the wall inside an open signed turn, a request that stays over the context window even
/// after the signed-thinking reset (every signed block stripped, every reclaimable block
/// dropped) is refused rather than sent. Here the turn's own prompt is larger than the
/// window, and nothing may reduce a user prompt. The refusal commits nothing.
#[test]
fn signed_prefix_hold_refuses_a_signed_turn_that_cannot_fit_after_the_reset() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "refuse-over-window");
    sim.ctx.protected_tools.clear();
    let prompt = (0..17_000)
        .map(|n| format!("entry{n:05} value{n:05}\n"))
        .collect::<String>();
    sim.messages[2] = item("u3", 3, &prompt);
    sim.run(false).unwrap();
    for _ in 0..2 {
        sim.tool_step();
        sim.run(false).unwrap();
    }
    let late = sim.tool_results.last().unwrap().clone();
    sim.s()
        .append_pending_agent_drops(&sim.session, std::slice::from_ref(&late), 1)
        .unwrap();
    let before = sim.s().load(&sim.session).unwrap().row_version;
    sim.used = 95_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = 120_000;
    match transform(sim.s(), &request, &sim.ctx) {
        Err(TransformError::SignedTurnOverLimit) => {}
        other => panic!("expected the over-window refusal, got {other:?}"),
    }
    assert_eq!(sim.s().load(&sim.session).unwrap().row_version, before);
    assert_eq!(
        review_pending(sim.s(), &sim.session),
        BTreeSet::from([late])
    );
}

/// The over-window refusal's code and message are a contract with the TypeScript host,
/// which turns this module error into its user-facing refusal.
#[test]
fn signed_turn_over_limit_refusal_matches_the_cross_language_contract() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/signed-turn-refusal.json"
    ))
    .unwrap();
    assert_eq!(
        SIGNED_TURN_OVER_LIMIT_CODE,
        golden["code"].as_str().unwrap()
    );
    assert_eq!(
        TransformError::SignedTurnOverLimit.to_string(),
        golden["message"].as_str().unwrap()
    );
}

/// Tool-call arguments count toward the wall. Here one bound call's arguments alone are over
/// the window, and a waiting publication with a lost m1 forces a head rebuild, so the pass
/// is first a signed-thinking reset. That reset pass must still fit or be refused: with its
/// thinking gone, the oversized call may be reclaimed; if not, it is refused.
#[test]
fn signed_prefix_hold_tool_call_input_reset_pass_fits_or_refuses() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, false, "tool-input-reset");
    sim.ctx.protected_tools.clear();
    sim.run(false).unwrap();
    sim.tool_step();
    let payload = (0..17_000)
        .map(|n| format!("entry{n:05} value{n:05}\n"))
        .collect::<String>();
    let call = sim
        .messages
        .iter_mut()
        .find(|message| message.mid == "a4")
        .unwrap()
        .ck
        .content
        .iter_mut()
        .find(|block| matches!(block.kind, ck_wire::CkKind::ToolCall { .. }))
        .unwrap();
    if let ck_wire::CkKind::ToolCall { input, .. } = &mut call.kind {
        *input = json!({ "content": payload });
    }
    sim.run(false).unwrap();
    sim.tool_step();
    sim.run(false).unwrap();
    let mut rng = ReviewRng(7);
    assert!(sim.publish(&mut rng), "the earlier turn can be summarized");
    signed_hold_delete_m1(sim.s(), &sim.session);
    sim.used = 95_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = 140_000;
    match transform(sim.s(), &request, &sim.ctx) {
        Err(TransformError::SignedTurnOverLimit) => {}
        Ok(response) => {
            assert!(response.signed_thinking_reset, "{}", response.action);
            let inputs: usize = response
                .messages()
                .iter()
                .flat_map(|message| &message.content)
                .filter_map(|block| match &block.kind {
                    ck_wire::CkKind::ToolCall { input, .. } => {
                        Some(mc_tokenizer::estimate_tokens(&input.to_string()))
                    }
                    _ => None,
                })
                .sum();
            assert!(inputs <= 100_000, "served {inputs} tool-call input tokens");
        }
        Err(other) => panic!("unexpected error: {other:?}"),
    }
}

/// A subagent's signed tool loop at 95% usage, with every large tool result sitting before
/// the loop's newest kept signed thinking (so per-target protection keeps all of them):
/// the subagent takes the same signed-thinking reset as a primary, through its
/// reductions-only branch. The reset strips the loop's thinking, the queued drops land, the
/// serve fits, and the next pass replays it.
#[test]
fn signed_prefix_hold_subagent_signed_loop_at_the_wall_resets_and_fits() {
    let mut sim = ReviewSession::new(REVIEW_BOUND, true, true, "subagent-wall-fit");
    sim.ctx.protected_tools.clear();
    sim.run(false).unwrap();
    let payload = (0..700)
        .map(|n| format!("entry{n:04} value{n:04}\n"))
        .collect::<String>();
    for _ in 0..22 {
        sim.tool_step();
        if let ck_wire::CkKind::ToolResult { output, .. } =
            &mut sim.messages.last_mut().unwrap().ck.content[0].kind
        {
            output.kind = ck_wire::CkOutputKind::Text {
                text: payload.clone(),
            };
        }
        sim.run(false).unwrap();
    }
    sim.tool_step();
    let baseline = sim.run(false).unwrap();
    let bound = review_r2_result_token_lower_bound(&baseline);
    assert!(bound > 100_000);
    sim.s()
        .append_pending_agent_drops(&sim.session, &sim.tool_results[..22], 1)
        .unwrap();
    sim.used = 95_000;
    let mut request = sim.request(false);
    let usage = request.usage.as_mut().unwrap();
    usage.final_wire_trusted = true;
    usage.final_wire_input_tokens = bound as u64;
    let reset = transform(sim.s(), &request, &sim.ctx).unwrap();
    assert!(reset.signed_thinking_reset, "{}", reset.action);
    assert_eq!(review_r3_reasoning_count(&reset), 0);
    assert!(review_r2_result_token_lower_bound(&reset) <= 100_000);
    assert!(review_pending(sim.s(), &sim.session).is_empty());
    // At 20% usage the next pass is a Defer: it serves the reset pass's bytes again, with
    // the thinking still removed by the persisted strip units.
    sim.used = 20_000;
    let replay = sim.run(false).unwrap();
    assert_eq!(replay.action, "SOFT+");
    assert!(!replay.signed_thinking_reset);
    assert_eq!(review_bytes(&replay), review_bytes(&reset));
}
