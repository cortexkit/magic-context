//! The emergency lane plans from what ck-mc measures about the request it
//! is about to serve. The fixed part is the runner's exact system-prompt
//! and tool-definition counts, the history head this pass serves and the
//! exact pending notes. The size is that fixed part plus the transcript this
//! pass serves or, for a request the runner says will not fit, the runner's
//! count plus what this pass changes in it. The provider's reading only
//! decides whether the lane may run in the force band.
//!
//! Most tests use one session whose plan stops partway through its
//! candidates, so that a lane sizing the request from the reading, one
//! inferring the fixed part from the reading, and one dropping everything
//! each select a different number of results.

use super::*;
use cortexkit_role_compaction::tokens::{PartTokens, SurfaceTokens};

/// The usable window of every session here: 60,000 tokens less 15,000 kept
/// for the reply. The execute ceiling is 65% of it, 29,250 tokens, and the
/// force band starts at 85%, 38,250 tokens.
const USABLE: u64 = 45_000;

fn exact(count: u64) -> Option<SurfaceTokens> {
    Some(SurfaceTokens::new(count, true))
}

fn inexact(count: u64) -> Option<SurfaceTokens> {
    Some(SurfaceTokens::new(count, false))
}

/// A `bash` result of `tokens` tokens in its own assistant message. Command
/// tools are the first tier the lane drops and have no newest share held
/// back, and each command differs, so no other lane removes a repeat.
fn result(tag: u64, tokens: u64) -> Entry {
    let mut part: Part = serde_json::from_value(serde_json::json!({
        "id":"p", "kind":"tool", "call_id":format!("c{tag}"), "name":"bash",
        "input":{"command":format!("make step-{tag}")}, "status":"completed",
        "output":"done", "output_bytes":4 * tokens, "digest":""
    }))
    .unwrap();
    part.tag = Some(tag);
    part.tokens = Some(PartTokens::tool(0, tokens));
    Entry::new(tag, format!("tool-{tag}"), Role::Assistant, tag, vec![part])
}

/// User text the runner counted at `tokens` tokens.
fn counted(tag: u64, name: &str, tokens: u64) -> Entry {
    let mut entry = text(tag, name);
    entry.parts[0].tokens = Some(PartTokens::count(tokens));
    entry
}

/// The entries of [`sized`]: a 1,000-token task, `old` results of 1,000
/// tokens (tags 2 to `old` + 1), three 300-token results that the protected
/// tail holds (the newest three calls) and a 100-token closing message.
fn entries(old: u64) -> Vec<Entry> {
    let mut entries = vec![counted(1, "task", 1_000)];
    entries.extend((2..=old + 1).map(|tag| result(tag, 1_000)));
    entries.extend((old + 2..=old + 4).map(|tag| result(tag, 300)));
    entries.push(counted(old + 5, "go on", 100));
    entries
}

/// A worker over [`entries`], whose runner counted the system prompt and
/// the tool definitions exactly, after a request the provider read at
/// `reading` tokens.
fn sized(old: u64, system: u64, tools: u64, reading: u64) -> (Session, Settings) {
    let (mut session, _, _, _, settings) = fixture();
    session.conditions.context_window = 60_000;
    session.conditions.output_reserve = 15_000;
    session.conditions.last_prompt_tokens = Some(reading);
    session.surface_tokens = (exact(system), exact(tools));
    session.index.extend_counted(entries(old), Some("family"));
    session.index_ready = true;
    (session, settings)
}

/// 33 old results, a fixed part of 10,000 tokens, 35,000 tokens of
/// transcript and a reading of 39,000, in the force band. The request is
/// 45,000 tokens and the target 10,000 + 30% of 19,250 = 15,775, so 29,225
/// tokens must go: exactly 30 results, and three eligible ones stay. Sized
/// from the reading with this fixed part, the lane would take 24 (23,225 to
/// free); inferring the fixed part as the reading less the transcript
/// (4,000) it takes 28; dropping everything takes 33.
fn partial() -> (Session, Settings) {
    sized(33, 4_000, 6_000, 39_000)
}

/// The newest tool tag of [`partial`].
const NEWEST: u64 = 37;

fn tag_of(mid: &str) -> Option<u64> {
    mid.strip_prefix("tool-")?.parse().ok()
}

/// Each tool result `view` removes, by tag, with how: `whole` when the
/// call goes with its result, `result` when only the result becomes its
/// placeholder.
fn taken(view: Option<&View>) -> Vec<(u64, &'static str)> {
    let mut taken: Vec<_> = view
        .into_iter()
        .flat_map(|view| &view.edits)
        .filter_map(|edit| match &edit.op {
            EditOp::Drop {
                mid,
                part: Some(part),
            } if part == "p" => tag_of(mid).map(|tag| (tag, "whole")),
            EditOp::Replace { mid, field, .. } if field == "output" => {
                tag_of(mid).map(|tag| (tag, "result"))
            }
            _ => None,
        })
        .collect();
    taken.sort();
    taken
}

/// The shapes a force-band pass gives `tags`: a recent call with a small
/// input keeps its call, an older one goes whole.
fn force(tags: std::ops::RangeInclusive<u64>, newest: u64) -> Vec<(u64, &'static str)> {
    tags.map(|tag| {
        let recent = tag + lanes::RECENT_TOOL_WINDOW as u64 > newest;
        (tag, if recent { "result" } else { "whole" })
    })
    .collect()
}

/// A request that will not fit drops every call whole.
fn whole(tags: std::ops::RangeInclusive<u64>) -> Vec<(u64, &'static str)> {
    tags.map(|tag| (tag, "whole")).collect()
}

/// The runner's ride for a request that will not fit, under the view
/// ck-mc holds as its newest.
fn over_limit(session: &Session, count: Option<u64>) -> RideRequest {
    let mut ride = RideRequest::new(
        vec![RideCause::OverLimit],
        1_000,
        session.conditions.clone(),
    );
    ride.applied_view = session.latest.as_ref().map(View::applied);
    match count {
        Some(count) => ride.with_request_tokens(count),
        None => ride,
    }
}

fn queue(session: &mut Session, tags: std::ops::RangeInclusive<u64>) {
    for tag in tags {
        session.queued.insert((format!("tool-{tag}"), "p".into()));
    }
}

fn build(session: &mut Session, settings: &Settings) -> Option<View> {
    session.build(settings, None, false, None).0
}

#[test]
fn emergency_measured_a_force_pass_stops_at_the_target() {
    let (mut session, settings) = partial();
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=31, NEWEST));
}

#[test]
fn emergency_measured_the_tool_definitions_count_changes_the_selection() {
    let (mut session, settings) = partial();
    assert_eq!(
        taken(build(&mut session, &settings).as_ref()),
        force(2..=31, NEWEST)
    );
    // The same reading and transcript with 4,000 fewer tool-definition
    // tokens: a 41,000-token request and a target of 6,000 + 30% of 23,250
    // = 12,975, so 28,025 must go, 29 results.
    let (mut session, settings) = sized(33, 4_000, 2_000, 39_000);
    assert_eq!(
        taken(build(&mut session, &settings).as_ref()),
        force(2..=30, NEWEST)
    );
}

#[test]
fn emergency_measured_an_inflated_reading_takes_one_batch_to_the_target() {
    // 18 old results: 20,000 tokens of transcript and a 30,000-token
    // request, two thirds of the window, read at twice its size.
    let (mut session, settings) = sized(18, 4_000, 6_000, 60_000);
    let first = build(&mut session, &settings).expect("the reading allows one batch");
    // 30,000 less the 15,775 target is 14,225: 15 results.
    assert_eq!(taken(Some(&first)), force(2..=16, 22));
    session.accept(first.clone());
    // A queued drop pays for another rewrite, so the batch the first pass
    // already took doesn't hold the lane back, and the reading still says
    // 60,000. The request is now below the target.
    session.queued.insert(("task".into(), "p".into()));
    let second = build(&mut session, &settings).expect("the queued drop lands");
    assert_eq!(taken(Some(&second)), taken(Some(&first)));
    assert!(second.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Replace { mid, field, .. } if mid == "task" && field == "text")));
}

#[test]
fn emergency_measured_an_undo_below_the_target_takes_no_batch() {
    let (mut session, settings) = partial();
    // The reading counted a 41,000-token request. An undo has since taken
    // back everything after the fifth result: what remains is the task,
    // two old 1,500-token results and three 300-token results in the tail,
    // 4,900 tokens, a 14,900-token request below the 15,775 target.
    session.conditions.last_prompt_tokens = Some(41_000);
    let mut kept = vec![
        counted(1, "task", 1_000),
        result(2, 1_500),
        result(3, 1_500),
    ];
    kept.extend((4..=6).map(|tag| result(tag, 300)));
    session.index = Index::default();
    session.index.extend_counted(kept, Some("family"));
    assert_eq!(build(&mut session, &settings), None);
    assert!(!session.next_latch);
}

#[test]
fn emergency_measured_a_counted_ride_takes_queued_drops_off_the_count_once() {
    let (mut session, settings) = partial();
    queue(&mut session, 2..=6);
    // The 47,000-token count less the 5,000 queued is 42,000 (the measured
    // sum is 40,000): 26,225 more must go, 27 results.
    let view = session.ride(&settings, &over_limit(&session, Some(47_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=33));
}

#[test]
fn emergency_measured_a_count_below_the_reading_is_planned_from() {
    let (mut session, settings) = partial();
    session.conditions.last_prompt_tokens = Some(60_000);
    // 47,000 less the 15,775 target is 31,225: 32 results.
    let view = session.ride(&settings, &over_limit(&session, Some(47_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=33));
}

#[test]
fn emergency_measured_a_count_below_the_measured_sum_is_raised_to_it() {
    let (mut session, settings) = partial();
    // ck-mc counts 45,000 where the runner counts 42,000: the request is
    // planned at ck-mc's 45,000, so 30 results go.
    let view = session.ride(&settings, &over_limit(&session, Some(42_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=31));
}

#[test]
fn emergency_measured_a_ride_without_a_count_ignores_the_held_reading() {
    let (mut session, settings) = partial();
    session.conditions.last_prompt_tokens = Some(60_000);
    queue(&mut session, 2..=6);
    // The refusal says the request did not fit 45,000; the queued 5,000
    // come off that, leaving 40,000, the measured sum too. 24,225 must go:
    // 25 results besides the queued ones.
    let view = session.ride(&settings, &over_limit(&session, None));
    assert_eq!(taken(view.as_ref()), whole(2..=31));
}

#[test]
fn emergency_measured_queued_drops_are_in_neither_sum() {
    let (mut session, settings) = partial();
    queue(&mut session, 2..=6);
    // The request is 10,000 + 30,000 = 40,000: 24,225 must go, 25 results.
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=31, NEWEST));
}

#[test]
fn emergency_measured_exact_pending_notes_are_counted_once() {
    let (mut session, settings) = partial();
    session.notes.notice(exact(5_000), Some("family"));
    // The fixed part is 15,000 with the notes and the request 50,000; the
    // target is 15,000 + 30% of 14,250 = 19,275, so 30,725 must go: 31.
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=32, NEWEST));

    let (mut session, settings) = partial();
    session.notes.notice(exact(5_000), Some("family"));
    // The 51,000-token count already holds the notes: 31,725 must go, 32.
    let view = session.ride(&settings, &over_limit(&session, Some(51_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=33));
}

#[test]
fn emergency_measured_a_ride_under_an_older_view_plans_from_the_measured_sum() {
    for count in [Some(60_000), None] {
        let (mut session, settings) = partial();
        session.conditions.last_prompt_tokens = Some(60_000);
        // ck-mc has a newer view than the one the refused request used.
        session.version = 1;
        session.latest = Some(View::seal(1, Vec::new()));
        let mut ride = over_limit(&session, count);
        ride.applied_view = None;
        let view = session.ride(&settings, &ride);
        assert_eq!(taken(view.as_ref()), whole(2..=31), "count {count:?}");
    }
}

/// Fallbacks to the arithmetic that infers the fixed part from the reading:
/// a surface count absent or not exact, or one from before a surface
/// change. Each row gives the result that arithmetic gives.
#[test]
fn emergency_measured_an_unmeasured_fixed_part_keeps_the_inferred_plan() {
    type Surfaces = (Option<SurfaceTokens>, Option<SurfaceTokens>);
    let fallbacks: [(Surfaces, bool); 6] = [
        ((None, None), false),
        ((exact(4_000), None), false),
        ((None, exact(6_000)), false),
        ((inexact(4_000), exact(6_000)), false),
        ((exact(4_000), inexact(6_000)), false),
        ((exact(4_000), exact(6_000)), true),
    ];
    for (surfaces, surface_change) in fallbacks {
        let label = format!("{surfaces:?} surface_change={surface_change}");
        let start = || {
            let (mut session, settings) = partial();
            session.surface_tokens = surfaces;
            (session, settings)
        };
        let causes = |mut causes: Vec<RideCause>| {
            if surface_change {
                causes.push(RideCause::SurfaceChange);
            }
            causes
        };
        let pass = |session: &mut Session, settings: &Settings| {
            if surface_change {
                let ride = RideRequest::new(causes(vec![]), 1_000, session.conditions.clone());
                session.ride(settings, &ride)
            } else {
                build(session, settings)
            }
        };
        let ride = |session: &mut Session, settings: &Settings, count| {
            let mut ride = over_limit(session, count);
            ride.causes = causes(std::mem::take(&mut ride.causes));
            session.ride(settings, &ride)
        };

        // Inferred fixed part 4,000: a target of 11,575, 27,425 to free.
        let (mut session, settings) = start();
        let view = pass(&mut session, &settings);
        assert_eq!(taken(view.as_ref()), force(2..=29, NEWEST), "{label}");

        // Old notes of 1,000 and pending ones of 6,000 add 5,000 to the
        // inferred fixed part and to the request: 29 results.
        let (mut session, settings) = start();
        session.notes.notice(exact(1_000), Some("family"));
        session.notes.notice(exact(6_000), Some("family"));
        let view = pass(&mut session, &settings);
        assert_eq!(taken(view.as_ref()), force(2..=30, NEWEST), "{label}");

        // The count, less the queued 5,000, leaves a 12,000 inferred fixed
        // part: a target of 17,175, 24,825 to free.
        let (mut session, settings) = start();
        queue(&mut session, 2..=6);
        let view = ride(&mut session, &settings, Some(47_000));
        assert_eq!(taken(view.as_ref()), whole(2..=31), "{label}");

        // Without a count the usable window is the floor: 30 results.
        let (mut session, settings) = start();
        let view = ride(&mut session, &settings, None);
        assert_eq!(taken(view.as_ref()), whole(2..=31), "{label}");
    }
}

#[tokio::test]
async fn emergency_measured_counts_stay_suspect_after_a_surface_change_until_a_notice() {
    let client = Client::default();
    *client.entries.lock().unwrap() = entries(33);
    let (mut session, settings) = partial();
    session.conditions.last_prompt_tokens = Some(20_000);
    let ride = RideRequest::new(
        vec![RideCause::SurfaceChange],
        1_000,
        session.conditions.clone(),
    );
    session.ride(&settings, &ride);
    // No notice since the surfaces changed: the inferred arithmetic plans.
    // 47,000 less the 35,000 transcript is a 12,000 fixed part, a target of
    // 17,175 and 29,825 to free: 30 results. Measured, it would be 32.
    let view = session.ride(&settings, &over_limit(&session, Some(47_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=31));

    let mut request = notice(&session, 1, entries(33).last().map(cursor));
    request.applied_view = session.latest.as_ref().map(View::applied);
    request.conditions.last_prompt_tokens = Some(20_000);
    request.conditions.last_prompt_view = session.latest.as_ref().map(|view| view.version);
    request.conditions.system_tokens = exact(4_000);
    request.conditions.tools_tokens = exact(6_000);
    session.notice(&client, &settings, request).await;
    // Measured again: 5,000 of transcript remain, a 15,000 measured sum
    // below the 18,000 count; 2,225 must go, three results. The inferred
    // plan would take none: 20,000 less 5,000 leaves 15,000 fixed and only
    // 725 above its target.
    let logs = crate::test_log::capture();
    let view = session.ride(&settings, &over_limit(&session, Some(18_000)));
    let mut expected = whole(2..=31);
    expected.extend(whole(32..=34));
    assert_eq!(taken(view.as_ref()), expected, "{}", logs.text());
}

#[test]
fn emergency_measured_a_fixed_part_above_the_ceiling_skips_the_force_pass() {
    let (mut session, settings) = sized(33, 23_251, 6_000, 39_000);
    assert_eq!(build(&mut session, &settings), None);
    // At the ceiling the target is the ceiling itself, 29,250: every
    // eligible result goes from the 64,250-token request.
    let (mut session, settings) = sized(33, 23_250, 6_000, 39_000);
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=34, NEWEST));
}

#[test]
fn emergency_measured_a_refused_request_keeps_both_fit_rules() {
    for (system, expected) in [
        // Below the ceiling: a target of 29,249.3 from 64,249, every
        // result goes.
        (23_249, Some(whole(2..=37))),
        // At the ceiling the target is on the usable window, 29,250 + 30%
        // of 15,750 = 33,975: 30,275 must go, 31 results.
        (23_250, Some(whole(2..=32))),
        // Just below the usable window less 2,000: a target of 43,599.3
        // from 77,999, every result goes.
        (36_999, Some(whole(2..=37))),
        // At it, nothing can leave enough room.
        (37_000, None),
    ] {
        let (mut session, settings) = sized(33, system, 6_000, 39_000);
        let count = system + 6_000 + 35_000;
        let view = session.ride(&settings, &over_limit(&session, Some(count)));
        assert_eq!(
            view.as_ref().map(|view| taken(Some(view))),
            expected,
            "fixed {}",
            system + 6_000
        );
    }
}

#[test]
fn emergency_measured_views_below_the_band_are_byte_identical() {
    let views: Vec<_> = [(exact(4_000), exact(6_000)), (None, None)]
        .into_iter()
        .map(|surfaces| {
            let mut views = Vec::new();
            for ride in [false, true] {
                let (mut session, settings) = partial();
                session.conditions.last_prompt_tokens = Some(30_000);
                session.surface_tokens = surfaces;
                queue(&mut session, 2..=2);
                let view = if ride {
                    let ride = RideRequest::new(
                        vec![RideCause::ModelChange],
                        1_000,
                        session.conditions.clone(),
                    );
                    session.ride(&settings, &ride)
                } else {
                    build(&mut session, &settings)
                };
                let view = view.expect("the queued drop lands");
                assert_eq!(taken(Some(&view)), whole(2..=2));
                views.push(serde_json::to_string(&view).unwrap());
            }
            views
        })
        .collect();
    assert_eq!(views[0], views[1]);
}

#[test]
fn emergency_measured_the_plan_is_logged_with_its_sources() {
    let logs = crate::test_log::capture();
    let (mut session, settings) = partial();
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=31, NEWEST));
    assert!(
        logs.text().contains(
            "ck-mc: session: emergency drop planned session=s1 fixed_tokens=10000 fixed_from=measured size_tokens=45000 size_from=measured ceiling_tokens=29250 target_tokens=15775 selected=30"
        ),
        "{}",
        logs.text()
    );

    let logs = crate::test_log::capture();
    let (mut session, settings) = partial();
    session.surface_tokens = (None, None);
    let view = build(&mut session, &settings);
    assert_eq!(taken(view.as_ref()), force(2..=29, NEWEST));
    assert!(
        logs.text().contains(
            "ck-mc: session: emergency drop planned session=s1 fixed_tokens=4000 fixed_from=inferred size_tokens=39000 size_from=reading ceiling_tokens=29250 target_tokens=11575 selected=28"
        ),
        "{}",
        logs.text()
    );
}

/// What the history head of `view` costs, as ck-mc counts the text it
/// composes.
fn head_cost(session: &Session, view: &View) -> u64 {
    view.edits
        .iter()
        .filter(|edit| head::is_head(&edit.op))
        .map(|edit| match &edit.op {
            EditOp::Insert { message, .. } => {
                message
                    .texts
                    .iter()
                    .map(|text| session.counter().count(text))
                    .sum::<u64>()
                    + message.images.len() as u64 * crate::tokens::IMAGE_TOKENS
            }
            _ => 0,
        })
        .sum()
}

/// A summary of `content` from message `a` through `end` in a context
/// store at `dir`.
fn summarize(session: &mut Session, dir: &std::path::Path, end: &str, content: &str) {
    if session.db.is_none() {
        let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
        session.db = Some(Arc::new(db));
    }
    session
        .db
        .as_ref()
        .unwrap()
        .with_connection(|conn| {
            conn.execute("INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, created_at, harness) VALUES ('s1', 1, 1, 2, 'a', ?1, 'earlier work', ?2, ?2, 1, 'mock')", [end, content])
                .map_err(|e| e.to_string())
        })
        .unwrap();
    session.features.summarizer = true;
    session.load_summaries();
}

/// Results for `free` tokens, at 1,000 a result.
fn results_for(free: f64) -> u64 {
    (free.round() / 1_000.0).ceil() as u64
}

#[test]
fn emergency_measured_a_counted_ride_adds_the_head_growth() {
    let dir = scratch("emergency-head-growth");
    let (mut session, mut settings) = partial();
    settings.memory_enabled = false;
    session.conditions.last_prompt_tokens = Some(10_000);
    session.features.summarizer = true;
    let db = ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    session.db = Some(Arc::new(db));
    let first = build(&mut session, &settings).expect("the first view renders the head");
    assert!(taken(Some(&first)).is_empty());
    session.accept(first.clone());
    // A summary published since adds to the head. It ends at no message
    // ck-mc holds, so the cut stays where it was.
    summarize(
        &mut session,
        &dir,
        "",
        &"earlier work on the parser ".repeat(400),
    );
    let old_head = head_cost(&session, &first);
    // The runner counts 1,500 more than ck-mc's measure of the request
    // under the view it holds.
    let count = 10_000 + old_head + 35_000 + 1_500;
    let view = session
        .ride(&settings, &over_limit(&session, Some(count)))
        .expect("the request must shrink");
    assert!(!view
        .edits
        .iter()
        .any(|edit| matches!(edit.op, EditOp::Cut { .. })));
    let new_head = head_cost(&session, &view);
    let growth = new_head - old_head;
    assert!(growth >= 2_000, "the head grew by only {growth}");
    let fixed = (10_000 + new_head) as f64;
    let target = fixed + 0.3 * (29_250.0 - fixed);
    let expected = results_for((count + growth) as f64 - target);
    // Without the growth the size would be the larger of the count and the
    // measured sum: one or more results fewer.
    let without = results_for((count.max(10_000 + new_head + 35_000)) as f64 - target);
    assert!(without < expected && expected <= 33);
    assert_eq!(taken(Some(&view)), whole(2..=expected + 1));
    assert!(count + growth - expected * 1_000 <= USABLE);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn emergency_measured_the_retry_without_the_cut_plans_with_its_own_head() {
    let dir = scratch("emergency-retry-head");
    let (mut session, mut settings) = partial();
    settings.memory_enabled = false;
    // A system entry holding a running call follows the closing message, so
    // the cut a summary through it proposes stops at the closing message,
    // and the view's own check refuses a cut through the message the
    // request ends on. The pass is planned again without that cut.
    let mut call: Part = serde_json::from_value(serde_json::json!({
        "id":"p", "kind":"tool", "call_id":"c39", "name":"bash",
        "input":{"command":"make watch"}, "status":"running", "digest":""
    }))
    .unwrap();
    call.tag = Some(39);
    let running_cost = crate::tokens::part(&call);
    let running = Entry::new(39, "tool-39", Role::System, 39, vec![call]);
    session.index.extend_counted([running], Some("family"));
    summarize(
        &mut session,
        &dir,
        "tool-39",
        &"earlier work on the parser ".repeat(400),
    );
    assert_eq!(session.history_ops(&settings, false).1, Some(38));
    let transcript = 35_000 + running_cost;
    // No view yet: the runner counted the request without any head, 1,500
    // more than ck-mc's measure of it.
    let count = 10_000 + transcript + 1_500;
    let view = session
        .ride(&settings, &over_limit(&session, Some(count)))
        .expect("the no-cut ride can still reclaim");
    assert!(!view
        .edits
        .iter()
        .any(|edit| matches!(edit.op, EditOp::Cut { .. })));
    let head = head_cost(&session, &view);
    assert!(head >= 2_000, "the head costs only {head}");
    let fixed = (10_000 + head) as f64;
    let target = fixed + 0.3 * (29_250.0 - fixed);
    let expected = results_for((count + head) as f64 - target);
    assert!(expected <= 33);
    assert_eq!(taken(Some(&view)), whole(2..=expected + 1));
    std::fs::remove_dir_all(dir).unwrap();
}

/// [`partial`] with an old 3,000-token reasoning block in the message of
/// the oldest result and a newest one-token block that stays, so that a
/// zero reasoning budget clears the old one, and with the age sweep's
/// bookmark at tag 6, so the sweep takes the five oldest results.
fn with_reasoning_and_sweep(old: u64) -> (Session, Settings) {
    let (mut session, mut settings) = sized(old, 4_000, 6_000, 39_000);
    settings.keep_reasoning_tokens = 0;
    let reasoning = |id: &str, bytes: u64| -> Part {
        serde_json::from_value(serde_json::json!({
            "id":id, "kind":"reasoning", "text_bytes":bytes, "digest":""
        }))
        .unwrap()
    };
    let mut entries = entries(old);
    entries[1]
        .parts
        .insert(0, reasoning("old-thinking", 12_000));
    let newest = entries.len() - 2;
    entries[newest].parts.push(reasoning("new-thinking", 4));
    session.index = Index::default();
    session.index.extend_counted(entries, Some("family"));
    session.reclaim_bookmark = 6;
    (session, settings)
}

/// The last plan the lane logged: its size, its target and how many parts
/// it selected.
fn planned(logs: &str) -> (u64, Option<u64>, u64) {
    let line = logs
        .lines()
        .rfind(|line| line.contains("ck-mc: session: emergency drop planned"))
        .unwrap_or_else(|| panic!("no plan logged: {logs}"));
    let field = |name: &str| {
        line.split(' ')
            .find_map(|word| word.strip_prefix(&format!("{name}=")))
            .unwrap()
            .to_owned()
    };
    (
        field("size_tokens").parse().unwrap(),
        field("target_tokens").parse().ok(),
        field("selected").parse().unwrap(),
    )
}

/// The request the session serves now, counted as the lane counts it: the
/// runner's surface counts and exact notes, plus each part and the history
/// head as the newest view serves them.
fn serving(session: &Session) -> u64 {
    let (parts, head) =
        session.served_costs(session.latest.iter().flat_map(|v| &v.edits).map(|e| &e.op));
    let fixed = session.surface_tokens.0.unwrap().count
        + session.surface_tokens.1.unwrap().count
        + session.notes.pending.map_or(0, |notes| notes.count);
    fixed + head + parts.values().sum::<u64>()
}

#[test]
fn emergency_measured_reasoning_and_swept_output_on_the_same_pass_are_out_of_the_size() {
    let logs = crate::test_log::capture();
    let (mut session, settings) = with_reasoning_and_sweep(33);
    let view = build(&mut session, &settings).expect("the pass clears and drops");
    // The sweep takes results 2 to 6 and the old reasoning goes: 30,001
    // tokens of transcript stay (the newest reasoning is one token), a
    // 40,001-token request. 24,226 must go: 25 more results, 7 to 31.
    assert_eq!(taken(Some(&view)), force(2..=31, NEWEST));
    assert!(view.edits.iter().any(|edit| matches!(&edit.op,
        EditOp::Drop { mid, part: Some(part) } if mid == "tool-2" && part == "old-thinking")));
    assert_eq!(planned(&logs.text()), (40_001, Some(15_775), 25));
}

#[test]
fn emergency_measured_another_lanes_part_is_never_credited_at_its_original_size() {
    // A force pass: the five results the sweep takes are no candidates, so
    // the lane takes 25 more, as for queued drops.
    let (mut session, settings) = partial();
    session.reclaim_bookmark = 6;
    assert_eq!(
        taken(build(&mut session, &settings).as_ref()),
        force(2..=31, NEWEST)
    );
    // A ride: the swept results free nothing more when the lane takes them
    // whole. The 47,000 count less the 5,000 swept is 42,000, so 26,225 must
    // go: 27 results after them, 7 to 33. Crediting them at 1,000 each
    // would stop at 28.
    let (mut session, settings) = partial();
    session.reclaim_bookmark = 6;
    let view = session.ride(&settings, &over_limit(&session, Some(47_000)));
    assert_eq!(taken(view.as_ref()), whole(2..=33));
}

#[test]
fn emergency_measured_a_refused_request_takes_what_another_lane_leaves_whole() {
    // A fixed part of 41,000 and twenty 1,250-token results whose calls
    // keep a 1,000-byte command (250 tokens). The sweep takes the results
    // of tags 2 to 18 and keeps their calls; 4,335 or so tokens of calls stay
    // behind, and the three tail results hold 3,750. The request fits the
    // 45,000-token window only if those calls go too.
    let (mut session, settings) = fixture_with(41_000);
    let count = 41_000 + 26_100;
    let view = session
        .ride(&settings, &over_limit(&session, Some(count)))
        .expect("the request must shrink");
    assert_eq!(taken(Some(&view)), whole(2..=21));
    let served = serving(&session);
    assert!(served <= USABLE, "the request is still {served}");
}

/// A worker with a fixed part of `system` + 2,000 tokens over a 1,000-token
/// task, twenty results of 1,250 tokens with 1,000-byte commands counted at
/// 250 tokens, and a 100-token closing message. The age sweep's bookmark is
/// at tag 18, outside the three-call protected tail.
fn fixture_with(fixed: u64) -> (Session, Settings) {
    let (mut session, settings) = sized(0, fixed - 2_000, 2_000, 39_000);
    let mut entries = vec![counted(1, "task", 1_000)];
    for tag in 2..=21 {
        let mut part: Part = serde_json::from_value(serde_json::json!({
            "id":"p", "kind":"tool", "call_id":format!("c{tag}"), "name":"bash",
            "input":{"command":format!("{tag:04}{}", "x".repeat(996))},
            "status":"completed", "output":"done", "output_bytes":4_000, "digest":""
        }))
        .unwrap();
        part.tag = Some(tag);
        part.tokens = Some(PartTokens::tool(250, 1_000));
        entries.push(Entry::new(
            tag,
            format!("tool-{tag}"),
            Role::Assistant,
            tag,
            vec![part],
        ));
    }
    entries.push(counted(22, "go on", 100));
    session.index = Index::default();
    session.index.extend_counted(entries, Some("family"));
    session.reclaim_bookmark = 18;
    (session, settings)
}

/// One pass of each kind, where the lane selects nothing and where it
/// selects: the request the session then serves, counted as the lane counts,
/// is the lane's size within 2% when it selected nothing, and at most its
/// target (its size less what it planned to free) plus 2% of its size when
/// it selected. Work planned after the lane (answered images, text
/// compression, and the superseded reads and retried failures a ride drops)
/// only makes the served request smaller.
#[test]
fn emergency_measured_the_served_request_matches_the_plan_on_every_kind_of_pass() {
    type Pass = fn(&mut Session, &Settings) -> Option<View>;
    let notice: Pass = |session, settings| {
        let view = build(session, settings);
        if let Some(view) = &view {
            session.accept(view.clone());
        }
        view
    };
    let counted: Pass = |session, settings| {
        // The runner counts 500 more than ck-mc, 1% of these requests.
        let count = serving(session) + 500;
        session.ride(settings, &over_limit(session, Some(count)))
    };
    let uncounted: Pass = |session, settings| session.ride(settings, &over_limit(session, None));
    let dirs = [33, 8].map(|old| scratch(&format!("emergency-families-{old}")));
    // A summary through the fifth result: the pass moves the cut past it.
    let with_cut = |old: u64, dir: &std::path::Path| {
        let (mut session, mut settings) = sized(old, 4_000, 6_000, 39_000);
        settings.memory_enabled = false;
        summarize(
            &mut session,
            dir,
            "tool-6",
            &"earlier work on the parser ".repeat(150),
        );
        (session, settings)
    };
    let cases: Vec<(&str, bool, (Session, Settings), Pass)> = vec![
        ("notice in the band", true, partial(), notice),
        (
            "notice in the band",
            false,
            sized(3, 4_000, 6_000, 39_000),
            notice,
        ),
        ("counted ride", true, partial(), counted),
        (
            "counted ride",
            false,
            sized(3, 37_000, 6_000, 39_000),
            counted,
        ),
        ("ride without a count", true, partial(), uncounted),
        (
            "ride without a count",
            false,
            sized(3, 37_000, 6_000, 39_000),
            uncounted,
        ),
        (
            "notice moving the cut",
            true,
            with_cut(33, &dirs[0]),
            notice,
        ),
        (
            "notice moving the cut",
            false,
            with_cut(8, &dirs[1]),
            notice,
        ),
        (
            "notice clearing reasoning",
            true,
            with_reasoning_and_sweep(33),
            notice,
        ),
        (
            "notice clearing reasoning",
            false,
            with_reasoning_and_sweep(3),
            notice,
        ),
    ];
    for (kind, selects, (mut session, settings), pass) in cases {
        let logs = crate::test_log::capture();
        pass(&mut session, &settings);
        let (size, target, selected) = planned(&logs.text());
        let served = serving(&session);
        let margin = size as f64 * 0.02;
        println!(
            "{kind}, selects={selects}: size {size}, target {target:?}, selected {selected}, served {served}, size less served {}",
            size as i64 - served as i64
        );
        assert_eq!(selected > 0, selects, "{kind}");
        if selects {
            let target = target.expect("a plan that selects has a target");
            assert!(
                served as f64 <= target as f64 + margin,
                "{kind}: {served} > {target}"
            );
        } else {
            assert!(
                (served as f64 - size as f64).abs() <= margin,
                "{kind}: served {served}, planned {size}"
            );
        }
    }
    for dir in dirs {
        std::fs::remove_dir_all(dir).unwrap();
    }
}
