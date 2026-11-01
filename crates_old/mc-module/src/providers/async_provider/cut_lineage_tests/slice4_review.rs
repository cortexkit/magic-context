//! An independent adversarial test suite for conversations whose lineage
//! begins at a published cut, with its own seeds, step mix and content checks.
//!
//! It reuses the differential fixtures (`Pair`, the fake runner, the
//! production descent `descend_pair`) but uses a separate session generator
//! from the production cut tests (`production_cuts::session`). Every check that matters here is independent of the
//! full-processing side agreeing: the served model input of the newest view
//! is assembled from the transcript and inspected for
//!
//! - summaries of messages a revert removed (`summary through N` with `N`
//!   past the revert point);
//! - authored user text after the view's history coverage that is missing
//!   from the model input although no `ctx_reduce` named it;
//! - empty messages, tool results without their calls and adjacent assistant
//!   messages (`stack24_cache_review::Review`).
//!
//! Regression witnesses run by default. Passing controls and the long campaign
//! (`s4_independent_campaign`) are ignored; run them explicitly with `--ignored`.
use super::*;

#[path = "slice4_boundaries.rs"]
mod slice4_boundaries;
#[path = "slice4_guards.rs"]
mod slice4_guards;
#[path = "slice4_rereview.rs"]
mod slice4_rereview;
use std::sync::atomic::Ordering::Relaxed;

/// Turn on the full-input reference and the decision traces, as
/// `production_cuts::session` does, so `verify_passes` and the decision
/// comparison can run.
fn review_enable(pair: &Pair) {
    pair.oracle
        .h
        .provider_store
        .async_runtime
        .full_input_only
        .store(true, Relaxed);
    for side in [&pair.resident, &pair.oracle] {
        side.h
            .provider_store
            .async_runtime
            .record_notice_decisions
            .store(true, Relaxed);
        cut_seed::pass_trace::take(side.store() as *const McStore as usize);
        cut_seed::notice_trace::take(side.store() as *const McStore as usize);
    }
}

/// A provider process restart on both sides: the resident copies are gone.
fn review_restart(pair: &Pair) {
    for side in [&pair.resident, &pair.oracle] {
        side.h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .forget(&pair.reference);
    }
}

async fn review_history(pair: &mut Pair, end: u64) {
    let reference = pair.reference.clone();
    pair.both(&format!("review history through {end}"), |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, end) })
    })
    .await;
}

async fn review_ride(pair: &mut Pair, cause: &str) {
    let request = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":cause,"deadline_ms":10_000}});
    pair.both(&format!("review ride {cause}"), |side| {
        Box::pin(side.dispatch(request.clone()))
    })
    .await;
}

fn newest_ordinal(pair: &Pair) -> u64 {
    pair.transcript
        .entries
        .lock()
        .unwrap()
        .last()
        .map_or(0, |entry| entry.ordinal)
}

/// Append until the transcript ends on a turn's closing answer, so no view
/// range can end inside a tool arc.
fn review_complete_turn(pair: &Pair) {
    while newest_ordinal(pair) % 4 != 3 {
        pair.append(1);
    }
}

/// Publish history close to the newest message, let the provider publish a
/// view with a cut, and descend at it through the production Setup. With
/// `during`, the parent's historian publishes again after the cut was
/// staged and before the descending Setup.
async fn review_next_cut(
    pair: &mut Pair,
    rng: &mut Rng,
    previous: u64,
    child: &str,
    during: bool,
) -> u64 {
    review_complete_turn(pair);
    let last = newest_ordinal(pair);
    let end = (last - 20) / 4 * 4 + 3;
    review_history(pair, end).await;
    pair.notice(rng, None).await;
    let mut first = None;
    for _ in 0..8 {
        let held = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        first = held
            .published_cuts
            .values()
            .filter(|cut| {
                cut.first_ordinal > previous
                    && held.lineage.as_deref() == Some(cut.lineage.as_str())
            })
            .map(|cut| cut.first_ordinal)
            .max();
        if first.is_some() {
            break;
        }
        pair.append(4);
        review_ride(pair, "surface_change").await;
    }
    let first = first.expect("the review generator must publish advancing cuts");
    if during {
        review_history(pair, end + 4).await;
    }
    review_restart(pair);
    descend_pair(pair, first, child).await;
    first
}

/// The first text of a user message, as the fixtures write it.
fn user_text(profile: Profile, message: &Value) -> Option<String> {
    let (role, text) = match profile {
        Profile::OpenCode => (
            message.pointer("/info/role"),
            message.pointer("/parts/0/text"),
        ),
        Profile::Pi => (
            message.pointer("/message/role"),
            message.pointer("/message/content/0/text"),
        ),
        Profile::Anthropic => (
            message.get("role"),
            message
                .get("content")
                .filter(|content| content.is_string())
                .or_else(|| message.pointer("/content/0/text")),
        ),
        Profile::Broca => (message.get("role"), message.pointer("/content/0/text")),
    };
    (role.and_then(Value::as_str) == Some("user"))
        .then(|| text.and_then(Value::as_str).map(str::to_owned))
        .flatten()
}

/// Every `N` in `summary through N` in `model`.
fn summaries_in(model: &str) -> Vec<u64> {
    model
        .match_indices("summary through ")
        .filter_map(|(at, needle)| {
            let rest = &model[at + needle.len()..];
            let digits = rest
                .chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>();
            digits.parse().ok()
        })
        .collect()
}

/// The resident's newest view: its version, served model input and the
/// history coverage it was published with.
fn newest_view(pair: &Pair) -> Option<(u64, view::CompactionView, String, Option<u64>)> {
    let (views, _) = pair.resident.views(&pair.reference);
    let (version, json) = views.last()?.clone();
    let view: view::CompactionView = serde_json::from_str(&json).unwrap();
    let coverage = pair
        .resident
        .store()
        .load_async_compaction_views(&pair.reference)
        .unwrap()
        .0
        .into_iter()
        .find(|(published, _, _, _)| *published == version)
        .and_then(|(_, _, engine, _)| engine)
        .and_then(|engine| {
            serde_json::from_str::<Value>(&engine).unwrap()["history_through"].as_u64()
        });
    let model = String::from_utf8(pair.model_bytes(&view)).unwrap();
    Some((version, view, model, coverage))
}

/// Authored user messages after `after` (and at or after the view's first
/// range) whose text the newest view does not serve, although no
/// `ctx_reduce` named their tag.
fn missing_user_text(
    pair: &Pair,
    model: &str,
    view: &view::CompactionView,
    after: Option<u64>,
) -> Vec<u64> {
    let start = view.ranges.first().map_or(0, |range| match range {
        view::ViewRange::Replace { from, .. } | view::ViewRange::Keep { from, .. } => *from,
        _ => 0,
    });
    missing_user_text_from(pair, model, start, after)
}

/// `missing_user_text` from `start` on, whatever the view's first range.
fn missing_user_text_from(pair: &Pair, model: &str, start: u64, after: Option<u64>) -> Vec<u64> {
    let requested = pair.review.borrow().requested.clone();
    let entries = pair.transcript.entries.lock().unwrap();
    entries
        .iter()
        .filter(|entry| entry.ordinal >= start && after.is_none_or(|after| entry.ordinal > after))
        .filter(|entry| {
            !entry
                .tags
                .iter()
                .filter_map(|row| row.tag.as_deref().and_then(tags::parse_tag))
                .any(|tag| requested.contains(&tag))
        })
        .filter_map(|entry| {
            let text = user_text(pair.profile, &entry.message)?;
            let probe: String = text.chars().take(28).collect();
            (!model.contains(&probe)).then_some(entry.ordinal)
        })
        .collect()
}

/// The resident's newest view version, if any.
fn newest_version(pair: &Pair) -> Option<u64> {
    pair.resident
        .views(&pair.reference)
        .0
        .last()
        .map(|(version, _)| *version)
}

/// The independent content checks on the newest view when it is newer than
/// `before` (a view published by the last step, against the transcript it
/// was published for), as one message per problem; empty when it is sound.
fn content_problems(pair: &Pair, before: Option<u64>) -> Vec<String> {
    let Some((version, view, model, coverage)) = newest_view(pair) else {
        return Vec::new();
    };
    if before.is_some_and(|before| version <= before) {
        return Vec::new();
    }
    let mut problems = Vec::new();
    let missing = missing_user_text(pair, &model, &view, coverage);
    if !missing.is_empty() {
        problems.push(format!(
            "LOST_USER_TEXT view {version} (coverage {coverage:?}) omits authored user messages {missing:?}"
        ));
    }
    let newest = newest_ordinal(pair);
    let beyond = summaries_in(&model)
        .into_iter()
        .filter(|end| *end > newest)
        .collect::<Vec<_>>();
    if !beyond.is_empty() {
        problems.push(format!(
            "SUMMARY_PAST_TRANSCRIPT view {version} serves summaries through {beyond:?}; newest message {newest}"
        ));
    }
    problems
}

fn setup_request(pair: &Pair, lineage: &str, descends: Option<Value>, id: &str) -> Value {
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let mut request = serde_json::to_value(&state.setup).unwrap();
    request.as_object_mut().unwrap().remove("descends_from");
    request["lineage_id"] = json!(lineage);
    request["request_id"] = json!(id);
    if let Some(descends) = descends {
        request["descends_from"] = descends;
    }
    json!({"method":"compaction.setup","params":request})
}

/// A notice to the resident side only.
async fn resident_notice(pair: &mut Pair, rng: &mut Rng, descent: Option<String>) -> String {
    pair.seq += 1;
    let message = pair.notice_message(rng, descent);
    let outcome = match pair
        .resident
        .h
        .advance_compaction("fixture", &message)
        .await
    {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("{error:?}"),
    };
    pair.resident.settle().await;
    outcome
}

/// Notices (each after a completed turn) and rides on the resident side
/// until it publishes a view newer than `before`, at most four rounds.
/// Returns every notice outcome.
async fn publish_new_view(pair: &mut Pair, rng: &mut Rng, before: Option<u64>) -> String {
    let mut outcomes = Vec::new();
    for round in 0..4 {
        if round > 0 {
            pair.append(4);
            review_complete_turn(pair);
        }
        outcomes.push(resident_notice(pair, rng, None).await);
        if newest_version(pair) > before {
            break;
        }
        let ride = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"surface_change","deadline_ms":10_000}});
        outcomes.push(
            pair.resident
                .dispatch(ride)
                .await
                .chars()
                .take(80)
                .collect(),
        );
        if newest_version(pair) > before {
            break;
        }
    }
    outcomes.join(" | ")
}

/// A notice to the resident side with a chosen token estimate and no
/// events, acknowledging `applied`.
async fn resident_notice_at(pair: &mut Pair, est: u64, applied: Option<u64>) -> String {
    pair.seq += 1;
    let (last_ordinal, digest) = {
        let entries = pair.transcript.entries.lock().unwrap();
        let last = entries.last().unwrap();
        (
            last.ordinal,
            contract::digest::content_digest(&last.message),
        )
    };
    let lineage = pair.transcript.lineage.lock().unwrap().clone();
    let mut notice = notice::AdvanceNotice::new(
        &pair.reference,
        pair.seq,
        lineage.clone(),
        last_ordinal,
        digest,
        est,
        pair.model.clone(),
    )
    .with_window(100_000);
    if let Some(version) = applied {
        notice = notice.with_applied_view_version(version);
    }
    let mut headers = notice.to_headers();
    headers.insert("lineage_id".into(), lineage);
    let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
    let message = cortexkit_bus_trait::Message {
        subject: notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
        id: bus_id(&pair.reference, "advanced", pair.seq),
        digest: notice.digest().parse().unwrap(),
        headers,
    };
    let outcome = match pair
        .resident
        .h
        .advance_compaction("fixture", &message)
        .await
    {
        Ok(()) => "ok".to_owned(),
        Err(error) => format!("{error:?}"),
    };
    pair.resident.settle().await;
    outcome
}

/// Why the cut seed's prefix does not match the namespace now, if it does
/// not: each condition `LogicalPrefix::matches` checks for a cut prefix.
fn cut_prefix_report(pair: &Pair) -> String {
    let store = pair.resident.store();
    let state = load(store, &pair.reference).unwrap().unwrap();
    let Some(seed) = state.cut_seed.as_ref() else {
        return "no cut seed".into();
    };
    let namespace = state.namespace();
    let loaded = store.load(&namespace).unwrap();
    let compartments = store.load_compartments(&namespace).unwrap();
    let lineage = state.lineage.clone().unwrap_or_default();
    let prefix = seed.prefix(&lineage, state.generation, loaded.meta.revert_epoch);
    let held = state.logical_prefix.as_ref().map(|held| {
        (
            held.is_cut(),
            held.tail_from,
            held.matches(&lineage, state.generation, &loaded, &compartments),
        )
    });
    format!(
        "conversation failed {}; seed first {} seq {} boundary {:?}; namespace coverage {:?} seq {:?} boundary {:?} revert_epoch {}; compartments {:?}; seed prefix matches {}; held certificate (cut, tail, matches) {held:?}",
        state.failed(),
        seed.first_ordinal,
        seed.compartment_seq,
        seed.boundary_id,
        loaded.meta.coverage_ordinal,
        loaded.meta.coverage_compartment_seq,
        loaded.core.boundary_id,
        loaded.meta.revert_epoch,
        compartments
            .iter()
            .map(|c| (c.sequence, c.start_message, c.end_message))
            .collect::<Vec<_>>(),
        prefix.matches(&lineage, state.generation, &loaded, &compartments),
    )
}

/// The runner reverts its transcript to `through`, starts lineage `lineage`
/// and the person writes `add` new messages.
fn revert_transcript(pair: &Pair, through: u64, lineage: &str, salt: u64, add: u64) {
    pair.transcript
        .entries
        .lock()
        .unwrap()
        .truncate(through as usize + 1);
    *pair.transcript.lineage.lock().unwrap() = lineage.into();
    for side in [&pair.resident, &pair.oracle] {
        *side.runner.head.lock().unwrap() = None;
    }
    pair.append_salted(add, salt);
}

fn compartment_ends(side: &Side, reference: &str) -> Vec<i64> {
    let head = load_head(side.store(), reference).unwrap().unwrap();
    side.store()
        .load_compartments(&head.namespace())
        .unwrap()
        .into_iter()
        .map(|compartment| compartment.end_message)
        .collect()
}

/// The runner's `session.head` for a lineage that begins at `first`.
fn cut_head(pair: &Pair, lineage: &str, first: u64) -> Value {
    let entries = pair.transcript.entries.lock().unwrap();
    let cut = &entries[first as usize - 1];
    json!({"lineage_id":lineage,"first_ordinal":first,"last_ordinal":entries.last().unwrap().ordinal,
        "history_version":2,"updated_at":1,
        "cut":{"mid":cut.mid,"digest":contract::digest::content_digest(&cut.message),"written_at":cut.written_at.unwrap_or(1)}})
}

/// A pair that has descended at one production cut and taken a few notices
/// in the new lineage. Returns the generator and the cut's first ordinal.
async fn cut_pair(profile: Profile, seed: u64) -> (Pair, Rng, u64) {
    let mut rng = Rng(seed ^ 0x51CE_4A11_D00D_F00D);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    review_enable(&pair);
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(120);
    let first = review_next_cut(&mut pair, &mut rng, 0, "child", false).await;
    pair.append(8);
    review_complete_turn(&pair);
    pair.notice(&mut rng, None).await;
    (pair, rng, first)
}

/// S4-01. A revert below every cut starts a lineage at the session's first
/// message, and Setup runs for it without `descends_from` (compaction-provider
/// 0.5.1 §5.1). The summaries of the reverted messages must not be served.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_01_revert_below_every_cut_serves_no_summary_of_reverted_messages() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA001 + index as u64).await;
        let through = 15;
        assert!(first > through + 4);
        revert_transcript(&pair, through, "undo", 7_001, 4);
        review_complete_turn(&pair);
        *pair.resident.runner.floor.lock().unwrap() = None;
        let answer = pair
            .resident
            .dispatch(setup_request(&pair, "undo", None, "setup-undo"))
            .await;
        let mut before = newest_version(&pair);
        let mut outcome = publish_new_view(&mut pair, &mut rng, before).await;
        if newest_version(&pair) <= before {
            // Nothing published while the transcript is shorter than the
            // copied summary; the person keeps writing past it.
            pair.append(first + 12);
            review_complete_turn(&pair);
            before = newest_version(&pair);
            outcome = publish_new_view(&mut pair, &mut rng, before).await;
        }
        let ends = compartment_ends(&pair.resident, &pair.reference);
        let initial = summaries_in(&answer);
        let served = newest_view(&pair)
            .filter(|(version, ..)| before.is_none_or(|before| *version > before))
            .map(|(version, _, model, _)| (version, summaries_in(&model)));
        let leaked_initial = initial
            .iter()
            .filter(|end| **end > through)
            .collect::<Vec<_>>();
        let leaked_view = served
            .as_ref()
            .map(|(_, ends)| {
                ends.iter()
                    .filter(|end| **end > through)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !leaked_initial.is_empty()
            || !leaked_view.is_empty()
            || ends.iter().any(|end| *end > through as i64)
        {
            problems.push(format!(
                "{profile:?}: cut at {first}, reverted to {through}; Setup initial serves summaries through {leaked_initial:?}; new view {:?} serves {leaked_view:?}; namespace compartments end at {ends:?}; notice {outcome}",
                served.as_ref().map(|(version, _)| *version)
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-02. The same revert announced only by a notice whose lineage starts
/// at the first message (no Setup reached the provider, e.g. it restarted
/// with the Setup answer cached by the runner). The record keeps its cut
/// seed through the reset, so it reads from the old cut, never the new
/// lineage's start.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_02_reset_after_revert_below_cut_reads_the_new_lineage_from_its_start() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA101 + index as u64).await;
        let parent = pair.transcript.lineage.lock().unwrap().clone();
        let through = 15;
        let digest = {
            let entries = pair.transcript.entries.lock().unwrap();
            contract::digest::content_digest(&entries[through as usize].message)
        };
        revert_transcript(&pair, through, "undo", 7_101, 4);
        review_complete_turn(&pair);
        *pair.resident.runner.floor.lock().unwrap() = None;
        let outcome = resident_notice(
            &mut pair,
            &mut rng,
            Some(format!("{parent}:{through}:{digest}")),
        )
        .await;
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        if !state.entries.contains_key(&0) || state.cut_first_ordinal.is_some() {
            problems.push(format!(
                "{profile:?}: cut at {first}, reverted to {through}: held {:?}, cut_first_ordinal {:?}, lineage {:?}, resync {}; notice {outcome}",
                state.entries.keys().collect::<Vec<_>>(),
                state.cut_first_ordinal,
                state.lineage,
                state.resync
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-03. A revert between two cuts restarts at the earlier cut; its Setup
/// names the lineage that made that cut (§5.1). The served history must be
/// the earlier cut's, with the window rows after it and nothing that the
/// revert removed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_03_revert_to_an_earlier_cut_serves_that_cut() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA201 + index as u64).await;
        pair.append(60);
        let second = review_next_cut(&mut pair, &mut rng, first, "child-2", false).await;
        pair.append(8);
        review_complete_turn(&pair);
        pair.notice(&mut rng, None).await;
        // Revert to a turn end between the two cuts.
        let through = (first + (second - first) / 2) / 4 * 4 + 3;
        assert!(
            first <= through && through < second,
            "{first} {through} {second}"
        );
        revert_transcript(&pair, through, "rv", 7_201, 4);
        review_complete_turn(&pair);
        *pair.resident.runner.floor.lock().unwrap() = Some(first);
        let answer = pair
            .resident
            .dispatch(setup_request(
                &pair,
                "rv",
                Some(json!({"lineage_id":"L","through_ordinal":first - 1})),
                "setup-rv",
            ))
            .await;
        let before = newest_version(&pair);
        let outcome = publish_new_view(&mut pair, &mut rng, before).await;
        let ends = compartment_ends(&pair.resident, &pair.reference);
        let view = newest_view(&pair)
            .filter(|(version, ..)| before.is_none_or(|before| *version > before));
        let ready = answer.contains("\"ready\"");
        let report = match &view {
            Some((version, view, model, coverage)) => {
                let leaked = summaries_in(model)
                    .into_iter()
                    .filter(|end| *end > through)
                    .collect::<Vec<_>>();
                let missing = missing_user_text(&pair, model, view, *coverage);
                (!leaked.is_empty() || !missing.is_empty()).then(|| {
                    format!("view {version} serves summaries through {leaked:?} and omits user messages {missing:?}")
                })
            }
            None => Some("no view published".to_owned()),
        };
        let reads = pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .clone();
        if !ready
            || report.is_some()
            || !reads.is_empty()
            || ends.iter().any(|end| *end > through as i64)
        {
            problems.push(format!(
                "{profile:?}: cuts at {first} and {second}, reverted to {through}: Setup {}; {}; compartments end at {ends:?}; reads below the cut {reads:?}; notice {outcome}",
                answer.chars().take(200).collect::<String>(),
                report.unwrap_or_default()
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Control. A runner that lost its state starts a new lineage at the cut it
/// already applied and sends Setup without `descends_from` (§5.1, "a runner
/// that lost its state"). The transcript is unchanged, so the served history
/// must still carry the summary and every authored message after it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "review control (passes at 203fea8b8c): a restore at a published cut keeps the summary and window text"]
async fn s4_control_restore_at_a_published_cut_keeps_the_history() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA301 + index as u64).await;
        *pair.transcript.lineage.lock().unwrap() = "restored".into();
        *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "restored", first));
        let answer = pair
            .resident
            .dispatch(setup_request(&pair, "restored", None, "setup-restored"))
            .await;
        pair.append(4);
        review_complete_turn(&pair);
        let before = newest_version(&pair);
        let outcome = publish_new_view(&mut pair, &mut rng, before).await;
        let ends = compartment_ends(&pair.resident, &pair.reference);
        let newest_end = ends.iter().copied().max();
        let view = newest_view(&pair)
            .filter(|(version, ..)| before.is_none_or(|before| *version > before));
        let reads = pair
            .resident
            .runner
            .reads_below_floor
            .lock()
            .unwrap()
            .clone();
        let report = match &view {
            Some((version, view, model, coverage)) => {
                let summaries = summaries_in(model);
                let missing = missing_user_text(&pair, model, view, *coverage);
                (summaries.is_empty() || !missing.is_empty()).then(|| {
                    format!("view {version} (coverage {coverage:?}) serves summaries {summaries:?} and omits user messages {missing:?}")
                })
            }
            None => Some("no view published".to_owned()),
        };
        if !answer.contains("\"ready\"") || report.is_some() || !reads.is_empty() {
            problems.push(format!(
                "{profile:?}: cut at {first}, newest compartment end {newest_end:?}: Setup {}; {}; reads below the cut {reads:?}; notice {outcome}",
                answer.chars().take(200).collect::<String>(),
                report.unwrap_or_default()
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-04. A Setup whose runner reports a lineage starting at a cut ck-mc
/// never published and whose summaries do not reach (a host marker): the
/// messages between the newest summary and the cut are in neither the head
/// nor the lineage. The Setup must refuse rather than answer from the
/// summaries it holds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_04_setup_at_an_unpublished_uncovered_cut_refuses() {
    let mut problems = Vec::new();
    for profile in PROFILES {
        let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        pair.append(120);
        review_history(&mut pair, 39).await;
        let mut rng = Rng(0xA401);
        pair.notice(&mut rng, None).await;
        // The host cut at 80, far past the summaries (through 39).
        let first = 80;
        *pair.transcript.lineage.lock().unwrap() = "host".into();
        *pair.resident.runner.floor.lock().unwrap() = Some(first);
        *pair.resident.runner.head.lock().unwrap() = Some(cut_head(&pair, "host", first));
        let answer = pair
            .resident
            .dispatch(setup_request(&pair, "host", None, "setup-host"))
            .await;
        if answer.contains("\"ready\"") {
            let outcome = resident_notice(&mut pair, &mut rng, None).await;
            let served =
                newest_view(&pair).map(|(version, _, model, _)| (version, summaries_in(&model)));
            problems.push(format!(
                "{profile:?}: Setup at a cut through {} answered ready with summaries through 39 only; rows 40..{} are neither summarized nor readable; notice {outcome}; newest view {served:?}",
                first - 1,
                first - 1
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Control. A historian publication that rewinds the summary to end below
/// the lineage's cut uncovers messages the lineage cannot read. Full
/// processing of the same transcript serves them again; the cut lineage
/// must not serve less.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "review control (passes at 203fea8b8c): a summary rewound below the cut leaves no uncovered message unserved"]
async fn s4_control_summary_rewound_below_the_cut() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA501 + index as u64).await;
        let end = (first - 20) / 4 * 4 + 3;
        let reference = pair.reference.clone();
        for side in [&pair.resident, &pair.oracle] {
            publish_history(side, &reference, end);
        }
        pair.append(4);
        review_complete_turn(&pair);
        pair.record_only = true;
        pair.notice(&mut rng, None).await;
        if let Some((version, _, model, coverage)) = newest_view(&pair) {
            // Authored messages the shorter summary uncovered below the cut
            // that no served summary covers either.
            let summaries = summaries_in(&model);
            let lost = missing_user_text_from(&pair, &model, end + 1, Some(end))
                .into_iter()
                .filter(|ordinal| *ordinal < first && !summaries.iter().any(|end| end >= ordinal))
                .collect::<Vec<_>>();
            if !lost.is_empty() {
                problems.push(format!(
                    "{profile:?}: cut at {first}, summary rewound to {end}: view {version} (coverage {coverage:?}) serves summaries {:?} and omits uncovered user messages {lost:?}",
                    summaries_in(&model)
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Both sides' notice decisions since the last call, which must agree.
fn decisions_agree(pair: &Pair, seed: u64) -> usize {
    let resident = cut_seed::notice_trace::take(pair.resident.store() as *const McStore as usize);
    let oracle = cut_seed::notice_trace::take(pair.oracle.store() as *const McStore as usize);
    assert_eq!(
        resident, oracle,
        "DECISIONS {:?} seed {seed}: skip/run decisions diverged; steps={:?}",
        pair.profile, pair.log
    );
    oracle.len()
}

/// One step of the review's own mix inside a lineage that begins at
/// `first`. Unlike `Pair::cut_step` (the production cut tests' generator),
/// it forks and rewrites at or after the cut and rewinds the summary inside
/// the window.
async fn review_step(
    pair: &mut Pair,
    rng: &mut Rng,
    first: u64,
    seed: u64,
    kinds: Option<&[u64]>,
) -> &'static str {
    let mut kind = rng.below(12);
    // `kinds` narrows the mix (to bisect a failure, or to leave out the
    // kinds of a known finding); any other kind becomes an append.
    if kinds.is_some_and(|kinds| !kinds.contains(&kind)) {
        kind = 2;
    }
    match kind {
        0 => {
            review_restart(pair);
            pair.append(1 + rng.below(4));
            pair.notice(rng, None).await;
            "restart"
        }
        1 => {
            review_complete_turn(pair);
            let cause =
                ["surface_change", "model_change", "ttl_expired", "ceiling"][rng.below(4) as usize];
            review_ride(pair, cause).await;
            "ride"
        }
        2 | 3 => {
            pair.append(1 + rng.below(6));
            pair.notice(rng, None).await;
            "append"
        }
        4 => {
            let tags = pair.window_tags(first);
            if tags.is_empty() {
                return "none";
            }
            let chosen = tags[rng.below(tags.len() as u64) as usize];
            pair.review.borrow_mut().requested.insert(chosen);
            let request = json!({"name":"ctx_reduce","arguments":{"drop":chosen.to_string()}});
            pair.both("review ctx_reduce", |side| {
                Box::pin(side.dispatch(request.clone()))
            })
            .await;
            "drop"
        }
        5 | 6 => {
            // A summary that ends anywhere in the window, shorter or longer
            // than the last one.
            let last = newest_ordinal(pair);
            if last < first + 12 {
                pair.append(4);
                pair.notice(rng, None).await;
                return "append";
            }
            let end = (first + 4 + rng.below(last - first - 8)) / 4 * 4 + 3;
            review_history(pair, end.min(last)).await;
            review_complete_turn(pair);
            if rng.chance(50) {
                review_ride(pair, "surface_change").await;
            } else {
                pair.notice(rng, None).await;
            }
            "history"
        }
        7 => {
            // The runner rewrote its newest message: a digest mismatch.
            {
                let mut entries = pair.transcript.entries.lock().unwrap();
                let last = entries.last_mut().unwrap();
                *last = message(pair.profile, last.ordinal, 1 + rng.below(1_000));
            }
            pair.notice(rng, None).await;
            "rewrite"
        }
        8 => {
            // A fork at or after the cut, announced by its first notice.
            let last = newest_ordinal(pair);
            if last <= first + 2 {
                return "none";
            }
            let through = first + rng.below(last - first);
            let (parent, digest) = {
                let mut entries = pair.transcript.entries.lock().unwrap();
                entries.truncate(through as usize + 1);
                (
                    pair.transcript.lineage.lock().unwrap().clone(),
                    contract::digest::content_digest(&entries[through as usize].message),
                )
            };
            *pair.transcript.lineage.lock().unwrap() = format!("fork-{seed}-{}", pair.seq);
            pair.append_salted(1 + rng.below(4), 5_000 + pair.seq);
            pair.notice(rng, Some(format!("{parent}:{through}:{digest}")))
                .await;
            "fork"
        }
        9 => {
            let command = if rng.chance(50) {
                "ctx-status"
            } else {
                "ctx-flush"
            };
            let key = format!("review-{}-{}", pair.seq, pair.log.len());
            let request = json!({"name":"user_command.invoke","call_key":key,"arguments":{"command":command,"input":""}});
            pair.both(&format!("review command {command}"), |side| {
                let request = request.clone();
                let key = key.clone();
                Box::pin(async move {
                    let accepted = side.dispatch(request).await;
                    let result = if accepted.contains("accepted") {
                        command_result(side, &key).await
                    } else {
                        String::new()
                    };
                    format!("{accepted} => {result}")
                })
            })
            .await;
            "command"
        }
        _ => {
            let roll = [61, 66, 70, 93, 97][rng.below(5) as usize];
            pair.step_roll(rng, roll).await;
            "roll"
        }
    }
}

/// One review session: two production cuts, each followed by the review's
/// step mix, then (with `revert`) a revert below every cut through Setup.
async fn review_session(
    profile: Profile,
    seed: u64,
    steps: u64,
    revert: bool,
    kinds: Option<Vec<u64>>,
) -> (usize, usize) {
    let (decisions, passes, _) =
        review_session_inner(profile, seed, steps, revert, kinds, false).await;
    (decisions, passes)
}

async fn review_session_inner(
    profile: Profile,
    seed: u64,
    steps: u64,
    revert: bool,
    kinds: Option<Vec<u64>>,
    host_cases: bool,
) -> (usize, usize, cut_runtime::measurements::Stats) {
    let mut rng = Rng(seed ^ 0xD10F_629B_52A3_C947);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    cut_runtime::measurements::take(pair.resident.store());
    cut_runtime::measurements::take(pair.oracle.store());
    review_enable(&pair);
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(96 + 4 * rng.below(9));
    let mut previous = 0;
    let (mut decisions, mut passes) = (0, 0);
    let mut content = Vec::new();
    for cut in 0..2 {
        if cut != 0 {
            pair.append(48 + 4 * rng.below(5));
        }
        let during = rng.chance(35);
        let first = review_next_cut(
            &mut pair,
            &mut rng,
            previous,
            &format!("review-{seed}-{cut}"),
            during,
        )
        .await;
        decisions += decisions_agree(&pair, seed);
        passes += verify_passes(&pair, seed);
        let diagnose = std::env::var_os("MC_S4_DIAG").is_some();
        pair.record_only = diagnose;
        for _ in 0..steps {
            let before = newest_version(&pair);
            let kind = review_step(&mut pair, &mut rng, first, seed, kinds.as_deref()).await;
            // `record_only` logs every answer pair (each cut to 160
            // characters); a pair whose two sides differ is a divergence.
            let diverged = std::mem::take(&mut pair.mismatches)
                .into_iter()
                .filter(|line| {
                    line.split_once(": resident ")
                        .and_then(|(_, rest)| rest.split_once(" | oracle "))
                        .is_some_and(|(resident, oracle)| resident != oracle)
                })
                .collect::<Vec<_>>();
            if diagnose && !diverged.is_empty() {
                panic!(
                    "DIAG {profile:?} seed {seed} after {kind} (cut {first}): {diverged:?}; {}; steps={:?}",
                    cut_prefix_report(&pair),
                    pair.log
                );
            }
            decisions += decisions_agree(&pair, seed);
            passes += verify_passes(&pair, seed);
            pair.check_cut(first);
            for problem in content_problems(&pair, before) {
                content.push(format!("CONTENT after {kind} (cut {first}): {problem}"));
            }
        }
        if host_cases {
            slice4_boundaries::campaign_host_rewind(&mut pair, seed, cut).await;
            decisions += decisions_agree(&pair, seed);
            passes += verify_passes(&pair, seed);
        }
        previous = first;
    }
    if revert {
        // A revert below every cut: a new lineage from the first message,
        // with Setup first and no `descends_from` (compaction-provider 0.5.1
        // §5.1). Both sides take it; the check is independent of both.
        let through = 15 + 4 * rng.below(4);
        let old_newest = newest_ordinal(&pair);
        revert_transcript(&pair, through, &format!("undo-{seed}"), 9_000 + seed, 4);
        review_complete_turn(&pair);
        for side in [&pair.resident, &pair.oracle] {
            *side.runner.floor.lock().unwrap() = None;
        }
        let request = setup_request(&pair, &format!("undo-{seed}"), None, "setup-undo");
        pair.both("review revert Setup", |side| {
            Box::pin(side.dispatch(request.clone()))
        })
        .await;
        let before = newest_version(&pair);
        pair.notice(&mut rng, None).await;
        decisions += decisions_agree(&pair, seed);
        // Nothing is published while the transcript is shorter than the old
        // summaries; the person keeps writing past them.
        pair.append(old_newest - through + 8);
        review_complete_turn(&pair);
        pair.notice(&mut rng, None).await;
        review_ride(&mut pair, "surface_change").await;
        decisions += decisions_agree(&pair, seed);
        if let Some((version, _, model, _)) =
            newest_view(&pair).filter(|(version, ..)| before.is_none_or(|before| *version > before))
        {
            let leaked = summaries_in(&model)
                .into_iter()
                .filter(|end| *end > through)
                .collect::<Vec<_>>();
            if !leaked.is_empty() {
                content.push(format!(
                    "REVERT view {version} serves summaries through {leaked:?} after a revert to {through}"
                ));
            }
        }
    }
    let violations = {
        let mut review = pair.review.borrow_mut();
        review.check_served_edits();
        review.violations.clone()
    };
    assert!(
        pair.engine_mismatches.borrow().is_empty(),
        "ENGINE {profile:?} seed {seed}: {:?}",
        pair.engine_mismatches.borrow()
    );
    assert!(
        content.is_empty() && violations.is_empty(),
        "{} {profile:?} seed {seed}: content={content:?} review={violations:?}; steps={:?}",
        content
            .first()
            .map(|line| line.split_whitespace().next().unwrap_or("CONTENT"))
            .or_else(|| violations
                .first()
                .map(|line| line.split_whitespace().next().unwrap_or("REVIEW")))
            .unwrap_or("CONTENT"),
        pair.log
    );
    let stats = cut_runtime::measurements::take(pair.resident.store());
    cut_runtime::measurements::take(pair.oracle.store());
    (decisions, passes, stats)
}

/// The failure's kind: its leading word with digits removed.
fn failure_kind(message: &str) -> String {
    let at = message
        .find("panicked with message")
        .map_or(0, |at| at + 22);
    message[at..]
        .trim_start_matches(['"', ' '])
        .chars()
        .take(60)
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "independent cut-lineage campaign; long, run explicitly"]
async fn s4_independent_campaign() {
    let count = std::env::var("MC_S4_SESSIONS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(600);
    let start = std::env::var("MC_S4_FIRST_SEED")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0x6A09_E667);
    let steps = std::env::var("MC_S4_STEPS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(12);
    let revert = std::env::var_os("MC_S4_NO_REVERT").is_none();
    // `MC_S4_KINDS`: comma-separated step kinds to keep (see `review_step`).
    let step_kinds = std::env::var("MC_S4_KINDS").ok().map(|kinds| {
        kinds
            .split(',')
            .filter_map(|kind| kind.trim().parse::<u64>().ok())
            .collect::<Vec<_>>()
    });
    let mut kinds = BTreeMap::<String, Vec<u64>>::new();
    let (mut decisions, mut passes, mut failed) = (0, 0, 0);
    let mut stats = cut_runtime::measurements::Stats::default();
    for batch in (0..count).step_by(4) {
        let mut tasks = Vec::new();
        for index in batch..(batch + 4).min(count) {
            let seed = start + index;
            let profile = PROFILES[(index % 4) as usize];
            tasks.push((
                seed,
                profile,
                tokio::spawn(review_session_inner(
                    profile,
                    seed,
                    steps,
                    revert,
                    step_kinds.clone(),
                    true,
                )),
            ));
        }
        for (seed, profile, task) in tasks {
            match task.await {
                Ok((seen, proved, measured)) => {
                    decisions += seen;
                    passes += proved;
                    stats.merge(measured);
                }
                Err(error) => {
                    failed += 1;
                    let mut text = error.to_string();
                    // The engine-drift diagnostic is long and clock-laden;
                    // keep the failing check, the values and the steps.
                    if let (Some(start), Some(end)) =
                        (text.find("engine state drift:"), text.find("steps: ["))
                    {
                        if start < end {
                            text.replace_range(start..end, "[drift elided] ");
                        }
                    }
                    kinds.entry(failure_kind(&text)).or_default().push(seed);
                    // The head names the failing check; the tail holds the
                    // diverging values and the step log.
                    let chars = text.chars().collect::<Vec<_>>();
                    let head = chars.iter().take(400).collect::<String>();
                    let tail = chars
                        .iter()
                        .skip(chars.len().saturating_sub(3_000).max(400))
                        .collect::<String>();
                    eprintln!("S4 FAILURE seed={seed} profile={profile:?}: {head} … {tail}");
                }
            }
        }
        eprintln!(
            "S4 progress={}/{count} failed={failed} decisions={decisions} full_passes={passes}",
            (batch + 4).min(count)
        );
    }
    for (kind, seeds) in &kinds {
        eprintln!(
            "S4 KIND {} x{}: {kind} seeds={:?}",
            seeds.len(),
            seeds.len(),
            &seeds[..seeds.len().min(12)]
        );
    }
    eprintln!(
        "S4 SUMMARY sessions={count} seeds={start}..={} steps_per_cut={steps} step_kinds={step_kinds:?} codecs=4 failed={failed} matched_decisions={decisions} proved_full_passes={passes} revert={revert} max_prelude_bytes={} prelude_deferrals={} largest_deferred_bytes={} staged_cuts={} opencode_reverts={} pi_tree_switches={} cut_deferrals={:?}",
        start + count - 1
        , stats.max_prelude_bytes, stats.deferred_cuts, stats.largest_deferred_bytes, stats.staged_cuts, stats.opencode_reverts, stats.pi_tree_switches, stats.deferrals
    );
    assert_eq!(failed, 0, "independent campaign failures: {kinds:?}");
    if count >= 4 {
        assert!(
            stats.opencode_reverts > 0 && stats.pi_tree_switches > 0,
            "host rewind cases were not reached: {stats:?}"
        );
    }
}

/// Control. In a lineage that begins at a cut, notices under context pressure
/// after the summary moved inside the window. Full processing serves them;
/// the cut lineage must too (it has no rows below the cut to fall back on).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "review control (passes at 203fea8b8c): pressure notices after the summary moves inside the window"]
async fn s4_control_pressure_notices_after_the_summary_moves() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, _rng, first) = cut_pair(profile, 0xA601 + index as u64).await;
        let mut trail = Vec::new();
        for (round, est) in [20_000, 87_000, 96_000, 96_000, 30_000]
            .into_iter()
            .enumerate()
        {
            let end = (first + 8 + 4 * round as u64) / 4 * 4 + 3;
            if end + 4 < newest_ordinal(&pair) {
                let reference = pair.reference.clone();
                publish_history(&pair.resident, &reference, end);
                trail.push(format!("history {end}"));
            }
            pair.append(4);
            review_complete_turn(&pair);
            let applied = newest_version(&pair);
            let outcome = resident_notice_at(&mut pair, est, applied).await;
            trail.push(format!("notice est={est} applied={applied:?} -> {outcome}"));
            if outcome != "ok" {
                problems.push(format!(
                    "{profile:?}: cut at {first}: {trail:?}; {}",
                    cut_prefix_report(&pair)
                ));
                break;
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-05. A resync inside a lineage that begins at a cut: the runner
/// rewrote its newest message (a digest mismatch), or one page read failed
/// during a ceiling ride. Restoring the summaries clips them to the held
/// rows, which start at the cut, so the cut seed's prefix no longer matches,
/// every later pass fails and the conversation is marked failed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_05_resync_in_a_cut_lineage_keeps_publishing() {
    let mut problems = Vec::new();
    for trigger in ["newest message rewritten", "ceiling ride read failed"] {
        for (index, profile) in PROFILES.into_iter().enumerate() {
            let (mut pair, _rng, first) = cut_pair(profile, 0xA701 + index as u64).await;
            let ends_before = compartment_ends(&pair.resident, &pair.reference);
            if trigger == "newest message rewritten" {
                let mut entries = pair.transcript.entries.lock().unwrap();
                let last = entries.last_mut().unwrap();
                *last = message(profile, last.ordinal, 77);
            } else {
                // One failed page read during a ceiling ride (the fake runner
                // refuses a read below its floor), then the runner recovers.
                *pair.resident.runner.floor.lock().unwrap() = Some(newest_ordinal(&pair) + 100);
                let ride = json!({"method":"compaction.ride","params":{"session_ref":pair.reference,"cause":"ceiling","deadline_ms":10_000}});
                pair.resident.dispatch(ride).await;
                pair.resident
                    .runner
                    .reads_below_floor
                    .lock()
                    .unwrap()
                    .clear();
                *pair.resident.runner.floor.lock().unwrap() = Some(first);
            }
            let before = newest_version(&pair);
            let mut trail = Vec::new();
            for _ in 0..3 {
                let applied = newest_version(&pair);
                trail.push(resident_notice_at(&mut pair, 30_000, applied).await);
                pair.append(4);
                review_complete_turn(&pair);
            }
            if trail.iter().any(|outcome| outcome != "ok") || newest_version(&pair) <= before {
                problems.push(format!(
                    "{trigger}, {profile:?}: cut at {first}, summaries ended at {ends_before:?}; then notices {trail:?}, newest view {:?} (was {before:?}); {}",
                    newest_version(&pair),
                    cut_prefix_report(&pair)
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-06. A fork at or after the cut whose fork point is inside a summary
/// that straddles the cut: the fork drops that summary, nothing covers the
/// rows below the cut any more, and every later pass fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_06_fork_after_the_cut_keeps_publishing() {
    let mut problems = Vec::new();
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (mut pair, mut rng, first) = cut_pair(profile, 0xA801 + index as u64).await;
        pair.append(40);
        review_complete_turn(&pair);
        let end = (first + 28) / 4 * 4 + 3;
        publish_history(&pair.resident, &pair.reference.clone(), end);
        let applied = newest_version(&pair);
        let folded = resident_notice_at(&mut pair, 30_000, applied).await;
        let through = (first + 8) / 4 * 4 + 3;
        let parent = pair.transcript.lineage.lock().unwrap().clone();
        let digest = {
            let mut entries = pair.transcript.entries.lock().unwrap();
            entries.truncate(through as usize + 1);
            contract::digest::content_digest(&entries[through as usize].message)
        };
        *pair.transcript.lineage.lock().unwrap() = "forked".into();
        pair.append_salted(4, 5_123);
        let before = newest_version(&pair);
        let mut trail = vec![format!("fold {folded}")];
        trail.push(
            resident_notice(
                &mut pair,
                &mut rng,
                Some(format!("{parent}:{through}:{digest}")),
            )
            .await,
        );
        for _ in 0..2 {
            pair.append(4);
            review_complete_turn(&pair);
            let applied = newest_version(&pair);
            trail.push(resident_notice_at(&mut pair, 30_000, applied).await);
        }
        if trail.iter().skip(1).any(|outcome| outcome != "ok") || newest_version(&pair) <= before {
            problems.push(format!(
                "{profile:?}: cut at {first}, summary through {end}, fork at {through}: {trail:?}; newest view {:?} (was {before:?}); compartments end at {:?}; {}",
                newest_version(&pair),
                compartment_ends(&pair.resident, &pair.reference),
                cut_prefix_report(&pair)
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// S4-07. A replay of campaign seed 1779033703 (Broca) with forks after
/// the cut: the cut lineage keeps the todo state of a `todowrite` the fork
/// removed, where full processing holds the newest one the fork kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn s4_07_fork_replay_keeps_the_todo_state_full_processing_holds() {
    review_session(Profile::Broca, 1_779_033_703, 12, false, Some(vec![8, 2])).await;
}

/// S4-08. Every publication that carries a cut stages a namespace for it.
/// A later publication replaces the conversation's record of the cut, but
/// the namespace staged for the earlier one stays in the store.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s4_08_superseded_cut_stages_are_removed() {
    let mut problems = Vec::new();
    for profile in [Profile::Broca, Profile::OpenCode] {
        let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
        pair.append(120);
        let mut rng = Rng(0xA901);
        for round in 0..6u64 {
            pair.append(8);
            review_complete_turn(&pair);
            let newest = newest_ordinal(&pair);
            let end = (newest - 12) / 4 * 4 + 3;
            review_history(&mut pair, end.min(newest - 8)).await;
            let _ = round;
            pair.notice(&mut rng, None).await;
        }
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let prefix = state
            .namespace()
            .rsplit_once(':')
            .map(|(prefix, _)| prefix.to_owned())
            .unwrap();
        let referenced = serde_json::to_value(&state.published_cuts)
            .unwrap()
            .as_object()
            .unwrap()
            .values()
            .filter_map(|cut| cut["generation"].as_u64())
            .collect::<BTreeSet<_>>();
        let high = state.engine.version_high_water;
        let orphans = (1..=high)
            .map(|version| state.generation + version + 1)
            .filter(|generation| {
                !referenced.contains(generation) && *generation != state.generation
            })
            .filter(|generation| {
                pair.resident
                    .store()
                    .load_namespace_head(&format!("{prefix}:{generation}"))
                    .unwrap()
                    .is_some()
            })
            .collect::<Vec<_>>();
        if !orphans.is_empty() {
            problems.push(format!(
                "{profile:?}: {} views, cuts kept for generations {referenced:?}; staged namespaces nothing references: {orphans:?}",
                high
            ));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Earlier cut markers remain addressable after undo, so advancing cuts no
/// longer retire their stages. Republishing the same cut still supersedes a
/// stage and must reclaim it after the replacement is durably saved.
#[tokio::test]
async fn s4_08_same_cut_supersession_reclaims_the_old_stage() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(120);
    review_history(&mut pair, 99).await;
    pair.notice(&mut Rng(0xA908), None).await;
    let store = pair.resident.store();
    let state = load(store, &pair.reference).unwrap().unwrap();
    let first = state.newest_published_cut().unwrap().first_ordinal;
    let old = state.cached_cut(first).unwrap().clone();
    let old_namespace = format!("{}:async:{}", state.key.engine_key(), old.generation);
    assert!(store.load_namespace_head(&old_namespace).unwrap().is_some());
    store.arm_soft_refresh(&state.namespace()).unwrap();
    review_ride(&mut pair, "surface_change").await;
    let state = load(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert!(state.cached_cut(first).unwrap().version > old.version);
    assert!(pair
        .resident
        .store()
        .load_namespace_head(&old_namespace)
        .unwrap()
        .is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn s4_replays_the_remaining_campaign_failures() {
    let mut failures = Vec::new();
    for (profile, seed, revert) in [
        (Profile::OpenCode, 1_779_033_704, true),
        (Profile::Anthropic, 1_779_034_034, true),
        (Profile::OpenCode, 3_144_134_282, false),
        (Profile::Pi, 3_144_134_303, false),
        (Profile::Broca, 3_144_134_321, false),
        (Profile::OpenCode, 3_144_134_350, false),
        (Profile::OpenCode, 3_144_134_374, false),
    ] {
        if std::env::var("MC_S4_REPLAY_SEED")
            .ok()
            .is_some_and(|selected| selected != seed.to_string())
        {
            continue;
        }
        let kinds = revert.then(|| vec![0, 1, 2, 3, 4, 5, 6, 9, 10, 11]);
        if let Err(error) = tokio::spawn(review_session(profile, seed, 12, revert, kinds)).await {
            failures.push(format!("{profile:?} {seed}: {error}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "diagnostic replay of one native-host campaign session"]
async fn s4_replay_host_campaign_seed() {
    let number = std::env::var("MC_S4_REPLAY_SEED")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let profile = PROFILES[std::env::var("MC_S4_REPLAY_PROFILE")
        .unwrap()
        .parse::<usize>()
        .unwrap()];
    let kinds = std::env::var("MC_S4_KINDS")
        .ok()
        .map(|text| text.split(',').map(|n| n.parse::<u64>().unwrap()).collect());
    let revert = std::env::var_os("MC_S4_NO_REVERT").is_none();
    review_session_inner(profile, number, 12, revert, kinds, true).await;
}
