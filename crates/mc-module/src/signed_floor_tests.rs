//! The runner's signed floor: ck-mc holds the floor the latest Setup, notice
//! or ride states, drops it when a refusal shows the runner does not apply
//! it, saves it with the session, and stops treating the signed reasoning it
//! covers as sent.

use super::*;
use cortexkit_role_compaction::SignedFloor;

const MOVED: &str = "signed floor moved";
const REGRESSED: &str = "signed_floor_regressed";
const CONTRADICTED: &str = "signed_floor_contradicted";

fn transcript() -> Vec<Entry> {
    (1..=4).map(|n| text(n, &format!("m{n}"))).collect()
}

/// A notice whose conditions name `through` as the signed floor.
fn floor_notice(session: &Session, seq: u64, through: &str) -> NoticeRequest {
    let mut request = notice(session, seq, transcript().last().map(cursor));
    request.conditions.signed_floor = Some(SignedFloor::new(through));
    request
}

/// A session set up on a transcript of four messages, with the floor Setup
/// reported, if any.
async fn set_up(floor: Option<&str>) -> (Session, Client, Route, SetupRequest, Settings) {
    let (mut session, client, route, mut request, settings) = fixture();
    *client.entries.lock().unwrap() = transcript();
    request.newest = transcript().last().map(cursor);
    if let Some(floor) = floor {
        request = request.with_signed_floor(SignedFloor::new(floor), true);
    }
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.index_ready);
    (session, client, route, request, settings)
}

#[tokio::test]
async fn signed_floor_setup_reports_it_and_ck_mc_takes_it() {
    let captured = crate::test_log::capture();
    let (session, ..) = set_up(Some("m2")).await;
    assert_eq!(session.signed_floor.as_deref(), Some("m2"));
    assert_eq!(session.signed_floor(), Some(2));
    assert_eq!(captured.count(MOVED), 1);
    // Without a floor in Setup there is none.
    let (session, ..) = set_up(None).await;
    assert_eq!(session.signed_floor, None);
    assert_eq!(session.signed_floor(), None);
}

/// Every notice states the floor in full: ck-mc holds exactly the floor
/// named, newer or older, and none when none is named.
#[tokio::test]
async fn signed_floor_conditions_state_it_in_full() {
    let captured = crate::test_log::capture();
    let (mut session, client, _, _, settings) = set_up(Some("m2")).await;
    session
        .notice(&client, &settings, floor_notice(&session, 1, "m3"))
        .await;
    assert_eq!(session.signed_floor(), Some(3));
    // The same floor again is no move and logs nothing.
    session
        .notice(&client, &settings, floor_notice(&session, 2, "m3"))
        .await;
    assert_eq!(captured.count(MOVED), 2);
    // An older floor is the runner's floor now.
    session
        .notice(&client, &settings, floor_notice(&session, 3, "m1"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("m1"));
    assert_eq!(session.signed_floor(), Some(1));
    assert_eq!(captured.count(MOVED), 3);
    // Conditions without a floor: the runner applies none.
    let mut without = notice(&session, 4, transcript().last().map(cursor));
    without.conditions.signed_floor = None;
    session.notice(&client, &settings, without).await;
    assert_eq!(session.signed_floor, None);
    assert_eq!(captured.count(REGRESSED), 1);
}

/// A notice naming an entry the index doesn't hold is taken as named, and
/// covers nothing ck-mc holds.
#[tokio::test]
async fn signed_floor_naming_an_entry_ck_mc_does_not_hold_covers_nothing() {
    let (mut session, client, _, _, settings) = set_up(None).await;
    session
        .notice(&client, &settings, floor_notice(&session, 1, "elsewhere"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("elsewhere"));
    assert_eq!(session.signed_floor(), None);
}

#[tokio::test]
async fn signed_floor_survives_a_restart_and_a_setup_after_it_still_decides() {
    let (session, client, route, request, settings) = set_up(Some("m3")).await;
    let bytes = serde_json::to_vec(&session.durable()).unwrap();
    let saved: crate::store::Durable = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(saved.signed_floor.as_deref(), Some("m3"));
    let (mut restored, ..) = fixture();
    restored.restore(saved);
    assert_eq!(restored.signed_floor.as_deref(), Some("m3"));
    // The runner's Setup after the restart reports an older floor. Setup is
    // the runner's whole statement, so ck-mc takes it over the one it saved.
    let lower = request.with_signed_floor(SignedFloor::new("m1"), true);
    restored
        .setup(&client, &settings, &route, &lower, restored.features)
        .await;
    assert_eq!(restored.signed_floor(), Some(1));
    // A session that never had a floor saves none, so its row is unchanged.
    let (plain, ..) = fixture();
    let saved = serde_json::to_value(plain.durable()).unwrap();
    assert!(saved.get("signed_floor").is_none());
}

/// Heavy signed reasoning in the current turn holds an execute pass, unless
/// the runner already strips it: then there is nothing left to protect.
#[test]
fn signed_floor_the_hold_ignores_heavy_reasoning_at_or_before_it() {
    let reasoning = |id: &str| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(8_000),
            },
        )
        .with_seal(cortexkit_role_compaction::part::Seal::Signed)
    };
    // 2,000 visible reasoning tokens in each of two steps after the prompt,
    // then a light step.
    let entries = vec![
        text(1, "prompt"),
        Entry::new(2, "m2", Role::Assistant, 2, vec![reasoning("r2")]),
        Entry::new(3, "m3", Role::Assistant, 3, vec![reasoning("r3")]),
        Entry::new(
            4,
            "m4",
            Role::Assistant,
            4,
            vec![Part::new("t4", PartBody::Text { text: "ok".into() })],
        ),
    ];
    let mut conditions = Conditions::new(
        ModelRef::new("test", "model"),
        100_000,
        1_000,
        ProviderRules::new(SignedParts::Bound, EditCost::Suffix),
    );
    // 70%: over the execute threshold, under the hold's cap.
    conditions.last_prompt_tokens = Some(69_300);
    let settings = Settings::default();
    let hold =
        |floor: Option<u64>| pass::signed_thinking_hold(&entries, &conditions, &settings, floor);
    assert!(hold(None));
    // The floor covers the first heavy step only: the second still holds.
    assert!(hold(Some(2)));
    // The floor covers both: nothing left to protect.
    assert!(!hold(Some(3)));
    assert!(!hold(Some(4)));
    assert!(!pass::heavy_signed_turn(&entries, &conditions, Some(3)));
}

/// Reasoning clearing measures what the next request sends: signed
/// reasoning the runner strips is neither counted nor dropped.
#[tokio::test]
async fn signed_floor_reasoning_clearing_leaves_stripped_reasoning_alone() {
    let (mut session, client, _, _, _) = set_up(None).await;
    let signed = |id: &str| {
        Part::new(
            id,
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(32_000),
            },
        )
        .with_seal(cortexkit_role_compaction::part::Seal::Signed)
    };
    // Four steps of 8,000 reasoning tokens after the four messages.
    let steps: Vec<Entry> = (5..=8)
        .map(|n| {
            Entry::new(
                n,
                format!("m{n}"),
                Role::Assistant,
                n,
                vec![signed(&format!("r{n}"))],
            )
        })
        .collect();
    session.index.extend(steps.clone());
    *client.entries.lock().unwrap() = transcript().into_iter().chain(steps).collect();
    let settings = Settings {
        keep_reasoning_tokens: 10_000,
        protected_tokens: Some(0),
        ..Settings::default()
    };
    let cleared = |session: &Session| -> Vec<String> {
        let edited = lanes::Edited::default();
        let context = lanes::Context {
            index: &session.index,
            edited: &edited,
            protected_tools: &settings.protected_tools,
            keep_first_message: false,
            signed_floor: session.signed_floor(),
        };
        lanes::reasoning_over_budget(&context, settings.keep_reasoning_tokens, false)
            .into_iter()
            .map(|((mid, _), _)| mid)
            .collect()
    };
    assert_eq!(cleared(&session), ["m5", "m6", "m7"]);
    session.conditions.signed_floor = Some(SignedFloor::new("m6"));
    session.take_signed_floor();
    assert_eq!(cleared(&session), ["m7"]);
    // The projected usage after the drops weighs what they free against
    // what is sent: the four one-token messages and the 16,000 reasoning
    // tokens after the floor, not the 16,000 the runner strips.
    let projected = session.usage_after_drops(&settings, 0.9).unwrap();
    let expected = 0.9 * (1.0 - 8_000.0 / 16_004.0);
    assert!(
        (projected - expected).abs() < 1e-9,
        "{projected} vs {expected}"
    );
    session.conditions.signed_floor = Some(SignedFloor::new("m7"));
    session.take_signed_floor();
    assert!(cleared(&session).is_empty());
    assert_eq!(session.usage_after_drops(&settings, 0.9), None);
    // The runner states no floor: all of that reasoning is sent again, so
    // it is measured and cleared again.
    session.conditions.signed_floor = None;
    session.take_signed_floor();
    assert_eq!(cleared(&session), ["m5", "m6", "m7"]);
}

/// A completed tool call whose output is `output_bytes` long.
fn tool_output(id: &str, tag: u64, output_bytes: u64) -> Part {
    let mut part: Part = serde_json::from_value(serde_json::json!({
        "id": id, "kind": "tool", "call_id": id, "name": "read", "input": {"path": id},
        "status": "completed", "output": "result", "output_bytes": output_bytes, "digest": ""
    }))
    .unwrap();
    part.tag = Some(tag);
    part
}

/// On a route whose signed reasoning is bound to the request prefix: two old
/// tool outputs, a step whose signed reasoning `thought/r` was signed after
/// them, the entry a runner's floor names (`floor`), then three newer tool
/// calls that keep the old outputs out of the protected tail, and a prompt.
/// Dropping either old output invalidates `thought/r` unless a floor covers
/// it.
pub(super) fn bound_transcript() -> Vec<Entry> {
    let reasoning = Part::new(
        "r",
        PartBody::Reasoning {
            text: None,
            text_bytes: Some(400),
        },
    )
    .with_seal(cortexkit_role_compaction::part::Seal::Signed);
    let said = Part::new(
        "t",
        PartBody::Text {
            text: "done".into(),
        },
    );
    vec![
        text(1, "task"),
        Entry::new(
            2,
            "old",
            Role::Assistant,
            2,
            vec![tool_output("p", 2, 40_000), tool_output("p2", 3, 40_000)],
        ),
        Entry::new(3, "thought", Role::Assistant, 3, vec![reasoning, said]),
        text(4, "floor"),
        Entry::new(
            5,
            "newer",
            Role::Assistant,
            5,
            vec![
                tool_output("q1", 4, 10),
                tool_output("q2", 5, 10),
                tool_output("q3", 6, 10),
            ],
        ),
        text(6, "next"),
    ]
}

/// The two old outputs, which the model asked ck-mc to drop.
fn requested() -> BTreeSet<lanes::PartKey> {
    [("old".into(), "p".into()), ("old".into(), "p2".into())].into()
}

/// A session on [`bound_transcript`], set up with the floor Setup names, if
/// any, and both old outputs queued for dropping.
pub(super) async fn bound_set_up(
    floor: Option<&str>,
) -> (Session, Client, Route, SetupRequest, Settings) {
    let (mut session, client, route, mut request, settings) = fixture();
    request.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    *client.entries.lock().unwrap() = bound_transcript();
    request.newest = bound_transcript().last().map(cursor);
    if let Some(floor) = floor {
        request = request.with_signed_floor(SignedFloor::new(floor), true);
    }
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.index_ready);
    session.queued = requested();
    (session, client, route, request, settings)
}

/// A notice at 90% of the window on [`bound_transcript`], naming `floor`.
pub(super) fn bound_notice(session: &Session, seq: u64, floor: Option<&str>) -> NoticeRequest {
    let mut request = notice(session, seq, bound_transcript().last().map(cursor));
    request.conditions.signed_floor = floor.map(SignedFloor::new);
    request.conditions.last_prompt_tokens = Some(90_000);
    request
}

/// What a runner that applies no floor answers a view keeping `thought/r`.
fn thought_refused() -> ViewRefusal {
    ViewRefusal::Rule(RuleBreak::SignedPartInvalid {
        mid: "thought".into(),
        part: "r".into(),
    })
}

pub(super) fn keeps_thought(view: &View) -> bool {
    !view.edits.iter().any(|edit| {
        matches!(&edit.op, EditOp::Drop { mid, part: Some(part) } if mid == "thought" && part == "r")
    })
}

pub(super) fn carries_requested(view: &View) -> bool {
    requested().iter().all(|(mid, part)| {
        view.edits.iter().any(|edit| {
            matches!(&edit.op, EditOp::Replace { mid: m, part: p, .. } if m == mid && p == part)
        })
    })
}

/// The view library's check as a runner that applies no signed floor runs it.
pub(super) fn check_without_floor(session: &Session, view: &View) {
    if let Err(broken) = cortexkit_compaction_view::rules::check(
        session.index.entries(),
        &view.edits,
        &session.conditions.rules,
        cortexkit_compaction_view::rules::Floor::none(),
    ) {
        panic!(
            "a runner with no floor refuses view {}: {broken:?}",
            view.version
        );
    }
}

/// The runner lost its floor and sets the session up again without one.
/// ck-mc must stop keeping the signed reasoning the old floor covered, or
/// the runner refuses every view it builds.
#[tokio::test]
async fn signed_floor_a_setup_naming_none_takes_it_away() {
    let captured = crate::test_log::capture();
    let (mut session, client, route, request, settings) = bound_set_up(Some("floor")).await;
    assert_eq!(session.signed_floor(), Some(4));
    let mut lost = request;
    lost.signed_floor = None;
    session
        .setup(&client, &settings, &route, &lost, session.features)
        .await;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the requested drops build a view");
    assert!(carries_requested(&view));
    check_without_floor(&session, &view);
    assert!(!keeps_thought(&view));
    assert_eq!(session.signed_floor, None);
    assert_eq!(captured.count(REGRESSED), 1);
    // A restart does not bring the old floor back.
    let saved: crate::store::Durable =
        serde_json::from_slice(&serde_json::to_vec(&session.durable()).unwrap()).unwrap();
    let (mut restored, ..) = fixture();
    restored.restore(saved);
    assert_eq!(restored.signed_floor, None);
}

/// A notice naming no floor takes it away before its own pass builds: the
/// view that pass sends is one a runner with no floor takes.
#[tokio::test]
async fn signed_floor_a_notice_naming_none_takes_it_away_before_its_pass_builds() {
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    session
        .notice(&client, &settings, bound_notice(&session, 1, None))
        .await;
    assert_eq!(session.signed_floor, None);
    let offered = client.offered.lock().unwrap().clone();
    let [view] = offered.as_slice() else {
        panic!("one view offered: {offered:?}");
    };
    assert!(carries_requested(view));
    check_without_floor(&session, view);
}

#[tokio::test]
async fn signed_floor_a_ride_naming_an_older_floor_is_taken() {
    let (mut session, _, _, _, settings) = bound_set_up(Some("floor")).await;
    let mut conditions = session.conditions.clone();
    conditions.signed_floor = Some(SignedFloor::new("thought"));
    let _ = session.ride(&settings, &RideRequest::new(Vec::new(), 1_000, conditions));
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
    assert_eq!(session.signed_floor(), Some(3));
}

#[tokio::test]
async fn signed_floor_a_setup_naming_an_older_floor_is_taken() {
    let (mut session, client, route, request, settings) = bound_set_up(Some("floor")).await;
    let older = request.with_signed_floor(SignedFloor::new("thought"), true);
    session
        .setup(&client, &settings, &route, &older, session.features)
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("thought"));
    assert_eq!(session.signed_floor(), Some(3));
}

/// A Setup naming an entry the index doesn't hold replaces ck-mc's floor:
/// the runner's statement is taken as named, and it covers nothing ck-mc
/// holds. That is no floor going away, so nothing warns.
#[tokio::test]
async fn signed_floor_a_setup_naming_an_entry_ck_mc_does_not_hold_covers_nothing() {
    let captured = crate::test_log::capture();
    let (mut session, client, route, request, settings) = bound_set_up(Some("floor")).await;
    let elsewhere = request.with_signed_floor(SignedFloor::new("elsewhere"), true);
    session
        .setup(&client, &settings, &route, &elsewhere, session.features)
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("elsewhere"));
    assert_eq!(session.signed_floor(), None);
    assert_eq!(captured.count(REGRESSED), 0);
    // The next view judges `thought/r` as if there were no floor.
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the requested drops build a view");
    assert!(!keeps_thought(&view));
    check_without_floor(&session, &view);
}

/// The runner refuses a view for keeping signed reasoning at or before
/// ck-mc's floor, with no Setup to say it lost the floor. The refusal drops
/// the floor, and the drops the view carried are not held against it.
#[tokio::test]
async fn signed_floor_a_refusal_at_or_before_it_drops_it_and_costs_no_drops() {
    let captured = crate::test_log::capture();
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    let (view, _) = session.build(&settings, None, false, None);
    let view = view.expect("the requested drops build a view");
    assert!(keeps_thought(&view), "kept under the floor");
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(thought_refused());
    session.publish(&client, view).await;
    let (retry, _) = session.build(&settings, None, false, None);
    let retry = retry.expect("the requested drops are still queued");
    check_without_floor(&session, &retry);
    assert!(carries_requested(&retry));
    assert_eq!(session.signed_floor, None);
    assert_eq!(session.queued, requested());
    assert!(session.refused_once.is_empty());
    assert!(session.failed_parts.is_empty());
    assert_eq!(captured.count(REGRESSED), 1);
    // A restart does not bring the floor back.
    let saved: crate::store::Durable =
        serde_json::from_slice(&serde_json::to_vec(&session.durable()).unwrap()).unwrap();
    let (mut restored, ..) = fixture();
    restored.restore(saved);
    assert_eq!(restored.signed_floor, None);
}

/// A refusal naming signed reasoning after the floor says nothing about the
/// floor: the floor stays and the usual refusal guard applies.
#[tokio::test]
async fn signed_floor_a_refusal_after_it_keeps_the_usual_guard() {
    let captured = crate::test_log::capture();
    let (mut session, client, _, _, settings) = bound_set_up(Some("task")).await;
    let (view, _) = session.build(&settings, None, false, None);
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(thought_refused());
    session
        .publish(&client, view.expect("the requested drops build a view"))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("task"));
    assert_eq!(session.refused_once, requested());
    assert_eq!(captured.count(REGRESSED), 0);
}

/// Publish the view the requested drops build and return its version, then
/// let the runner refuse it at the step boundary for keeping `thought/r`,
/// in a notice whose conditions name `floor`.
async fn refused_at_boundary(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    floor: Option<&str>,
) -> u64 {
    let (view, _) = session.build(settings, None, false, None);
    let view = view.expect("the requested drops build a view");
    assert!(keeps_thought(&view), "kept under the floor");
    let version = view.version;
    session.publish(client, view).await;
    let mut request = bound_notice(session, 1, floor);
    request.events.push(Event::ViewRefused {
        version,
        refusal: thought_refused(),
    });
    session.notice(client, settings, request).await;
    version
}

/// Check the view the refusing notice's own pass sent instead: newer than
/// the refused one, carrying the requested drops, and one a runner with no
/// floor accepts.
fn retried(session: &Session, client: &Client, refused: u64) {
    let retry = client.offered.lock().unwrap().last().cloned().unwrap();
    assert!(retry.version > refused, "the pass sent a new view");
    assert!(carries_requested(&retry));
    check_without_floor(session, &retry);
}

/// The runner refuses a view for keeping signed reasoning at or before the
/// floor while its conditions keep naming that floor: it contradicts
/// itself, and ck-mc trusts the refusal until the runner states another
/// floor or none.
#[tokio::test]
async fn signed_floor_a_refused_floor_the_runner_keeps_naming_is_ignored_until_it_states_another() {
    let captured = crate::test_log::capture();
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    let refused = refused_at_boundary(&mut session, &client, &settings, Some("floor")).await;
    assert_eq!(session.signed_floor, None);
    retried(&session, &client, refused);
    assert_eq!(captured.count(CONTRADICTED), 1);
    // The same floor again changes nothing and is not logged again.
    session
        .notice(&client, &settings, bound_notice(&session, 2, Some("floor")))
        .await;
    assert_eq!(session.signed_floor, None);
    assert_eq!(captured.count(CONTRADICTED), 1);
    // The first conditions naming no floor end the contradiction, so the
    // floor is taken when named again.
    session
        .notice(&client, &settings, bound_notice(&session, 3, None))
        .await;
    assert_eq!(session.signed_floor, None);
    session
        .notice(&client, &settings, bound_notice(&session, 4, Some("floor")))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("floor"));
    assert_eq!(captured.count(CONTRADICTED), 1);
}

/// The runner stops applying its floor without saying why: it refuses the
/// view built under it and, in the same notice, names no floor. ck-mc holds
/// none. When a later notice names the same floor again, ck-mc takes it,
/// although it is not newer than the one it had. A real undo is performed
/// in `signed_floor_review_a_refusal_after_ck_mc_followed_the_floor_away_costs_no_drops`.
#[tokio::test]
async fn signed_floor_a_refusal_with_no_floor_named_then_the_same_floor_named_again() {
    let captured = crate::test_log::capture();
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    let refused = refused_at_boundary(&mut session, &client, &settings, None).await;
    assert_eq!(session.signed_floor, None);
    retried(&session, &client, refused);
    session
        .notice(&client, &settings, bound_notice(&session, 2, Some("floor")))
        .await;
    assert_eq!(session.signed_floor.as_deref(), Some("floor"));
    assert_eq!(captured.count(CONTRADICTED), 0);
}

// Witnesses from the independent review of the floor-following change. Each
// fails while the defect it names stands; see
// `.cortexkit/internal-docs/audits/signed-floor-follow-review.md`.

/// On a route whose signed reasoning is bound: signed reasoning in `early`,
/// before the floor's entry, and in three steps after it, then a prompt.
/// Reasoning clearing with a budget of one step drops `s4/r` and `s5/r`
/// under the floor; `early/r` is the floor's to strip and `s6/r` is exempt
/// as the newest step's.
fn gap_transcript() -> Vec<Entry> {
    let step = |ordinal: u64, mid: &str| {
        let reasoning = Part::new(
            "r",
            PartBody::Reasoning {
                text: None,
                text_bytes: Some(32_000),
            },
        )
        .with_seal(cortexkit_role_compaction::part::Seal::Signed);
        Entry::new(ordinal, mid, Role::Assistant, ordinal, vec![reasoning])
    };
    vec![
        text(1, "task"),
        step(2, "early"),
        text(3, "floor"),
        step(4, "s4"),
        step(5, "s5"),
        step(6, "s6"),
        text(7, "next"),
    ]
}

/// A session on [`gap_transcript`] whose Setup names `floor`, with settings
/// that clear reasoning over one step's worth.
async fn gap_set_up() -> (Session, Client, Settings) {
    let (mut session, client, route, mut request, settings) = fixture();
    request.rules = ProviderRules::new(SignedParts::Bound, EditCost::Suffix);
    *client.entries.lock().unwrap() = gap_transcript();
    request.newest = gap_transcript().last().map(cursor);
    request = request.with_signed_floor(SignedFloor::new("floor"), true);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(session.index_ready);
    assert_eq!(session.signed_floor(), Some(3));
    let settings = Settings {
        keep_reasoning_tokens: 10_000,
        protected_tokens: Some(0),
        ..Settings::default()
    };
    (session, client, settings)
}

fn drops(view: &View, mid: &str) -> bool {
    view.edits.iter().any(
        |edit| matches!(&edit.op, EditOp::Drop { mid: m, part: Some(p) } if m == mid && p == "r"),
    )
}

/// Build the reasoning-clearing view under the floor and return it with the
/// refusal a runner that applies no floor gives it. That runner keeps
/// `early/r`, so the dropped `s4/r` and `s5/r` leave a gap between two kept
/// signed parts, which invalidates the later one, `s6/r` (signed parts may
/// be left out only as an oldest or newest run): the part it names is after
/// ck-mc's floor.
fn gap_view(session: &mut Session, settings: &Settings) -> (View, ViewRefusal) {
    let (view, _) = session.build(settings, None, false, None);
    let view = view.expect("reasoning clearing builds a view");
    assert!(drops(&view, "s4") && drops(&view, "s5"), "{view:?}");
    assert!(!drops(&view, "early") && !drops(&view, "s6"), "{view:?}");
    let broken = cortexkit_compaction_view::rules::check(
        session.index.entries(),
        &view.edits,
        &session.conditions.rules,
        cortexkit_compaction_view::rules::Floor::none(),
    )
    .expect_err("a runner that applies no floor refuses the view");
    assert!(
        matches!(&broken, RuleBreak::SignedPartInvalid { mid, part } if mid == "s6" && part == "r"),
        "the runner names the kept part after the gap: {broken:?}"
    );
    (view, ViewRefusal::Rule(broken))
}

/// A runner that does not apply ck-mc's floor refuses a view built under
/// it, naming the first part its own check finds invalid. When the floor's
/// fault shows as a gap, that part is after the floor, and ck-mc neither
/// drops its floor nor spares the view's drops: the reasoning drops are set
/// aside for good, and later views keep relying on the floor.
#[tokio::test]
async fn signed_floor_review_a_gap_refusal_naming_a_part_after_the_floor_still_disproves_it() {
    let (mut session, client, settings) = gap_set_up().await;
    let (view, refusal) = gap_view(&mut session, &settings);
    *client.refuse.lock().unwrap() = true;
    *client.refusal.lock().unwrap() = Some(refusal);
    session.publish(&client, view).await;
    // Both at once, so a failure shows the floor kept and the drops set
    // aside together.
    assert_eq!(
        (session.signed_floor.as_deref(), session.failed_parts.clone()),
        (None, BTreeSet::new()),
        "the refusal shows the runner does not strip early/r: ck-mc should drop its floor, and the reasoning drops were not at fault"
    );
    *client.refuse.lock().unwrap() = false;
    let (retry, _) = session.build(&settings, None, false, None);
    let retry = retry.expect("reasoning clearing builds again");
    check_without_floor(&session, &retry);
}

/// The same refusal reported at a step boundary, in the notice whose
/// conditions name no floor (the runner stopped applying it, for example
/// after an undo took the floor's entry off its path). The notice takes the
/// floor away, but the refusal is judged first, against the floor still
/// held, and its drops pay for the floor's fault.
#[tokio::test]
async fn signed_floor_review_a_gap_refusal_in_a_notice_naming_no_floor_sets_nothing_aside() {
    let (mut session, client, settings) = gap_set_up().await;
    let (view, refusal) = gap_view(&mut session, &settings);
    let version = view.version;
    session.publish(&client, view).await;
    let mut request = notice(&session, 1, gap_transcript().last().map(cursor));
    request.conditions.signed_floor = None;
    request.events.push(Event::ViewRefused { version, refusal });
    session.notice(&client, &settings, request).await;
    assert_eq!(session.signed_floor, None, "the notice names none");
    assert!(
        session.failed_parts.is_empty(),
        "the floor was at fault, not the reasoning drops, yet they are set aside: {:?}",
        session.failed_parts
    );
}

/// A notice whose newest entry is `newest` of [`bound_transcript`], with no
/// usage reading, so its pass builds nothing, naming `floor` as the signed
/// floor.
fn quiet_notice(session: &Session, seq: u64, newest: usize, floor: Option<&str>) -> NoticeRequest {
    let mut request = notice(session, seq, Some(cursor(&bound_transcript()[newest - 1])));
    request.conditions.signed_floor = floor.map(SignedFloor::new);
    request.conditions.last_prompt_tokens = None;
    request
}

/// A view built under the floor is accepted. Before the runner first serves
/// it, the person undoes back to before the floor's entry: the runner
/// applies no floor and names none, and ck-mc follows. At the next step the
/// runner refuses the view for keeping `thought/r`. The view relied on a
/// floor that has since gone, so its drops were not at fault, but the
/// refusal is judged against the floor ck-mc holds now (none) and counts
/// against the model's requested drops (`refused_once`). A redo brings the
/// floor back, and a second undo before the next view is served makes it a
/// second refusal against them, which forgets them.
#[tokio::test]
async fn signed_floor_review_a_refusal_after_ck_mc_followed_the_floor_away_costs_no_drops() {
    let (mut session, client, _, _, settings) = bound_set_up(Some("floor")).await;
    let mut seq = 0;
    for round in 0..2 {
        let (view, _) = session.build(&settings, None, false, None);
        let view = view.expect("the requested drops build a view");
        assert!(keeps_thought(&view), "round {round}: kept under the floor");
        let version = view.version;
        session.publish(&client, view).await;
        assert_eq!(client.offered.lock().unwrap().len(), round + 1);
        // Undo back to `thought`: the floor's entry leaves the transcript.
        *client.entries.lock().unwrap() = bound_transcript()[..3].to_vec();
        seq += 1;
        let mut undo = quiet_notice(&session, seq, 3, None);
        undo.events
            .push(Event::TranscriptChanged { from_ordinal: 4 });
        session.notice(&client, &settings, undo).await;
        assert!(session.index_ready, "round {round}");
        assert_eq!(session.signed_floor, None, "round {round}");
        assert_eq!(
            client.offered.lock().unwrap().len(),
            round + 1,
            "round {round}: no view replaces the accepted one"
        );
        // The next step is the first to serve the view: refused.
        seq += 1;
        let mut refused = quiet_notice(&session, seq, 3, None);
        refused.events.push(Event::ViewRefused {
            version,
            refusal: thought_refused(),
        });
        session.notice(&client, &settings, refused).await;
        // Redo: the floor's entry is back, and the runner names it again.
        *client.entries.lock().unwrap() = bound_transcript();
        seq += 1;
        session
            .notice(
                &client,
                &settings,
                quiet_notice(&session, seq, 6, Some("floor")),
            )
            .await;
        assert_eq!(session.signed_floor(), Some(4), "round {round}");
    }
    assert_eq!(
        session.queued,
        requested(),
        "the model's requested drops were forgotten for refusals the floor caused"
    );
    assert!(
        session.refused_once.is_empty(),
        "{:?}",
        session.refused_once
    );
}
