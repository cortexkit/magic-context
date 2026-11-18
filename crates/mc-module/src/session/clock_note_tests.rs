//! The clock note on a session's own notices ([`crate::clock_note`]).

use super::*;
use cortexkit_role_compaction::part::{ToolPart, ToolStatus};
use cortexkit_role_llm_runner::delivery_order::Mode;
use serde_json::json;

const MINUTE: u64 = 60_000;
/// 2026-11-18T22:52:00Z, in milliseconds.
const T0: u64 = 1_795_042_320_000;

/// A runner that renders datetime templates, with every list mode.
fn datetime_runner() -> Value {
    json!({"capabilities": ["delivery_order", "template_datetime"]})
}

/// The model's reply at `ordinal`, calling a tool.
fn tool_call(ordinal: u64) -> Entry {
    let tool = ToolPart::new(
        format!("call-{ordinal}"),
        "read",
        json!({"path": "a.rs"}),
        ToolStatus::Completed,
    )
    .with_output("fn main() {}");
    let mut part = Part::new("p", PartBody::Tool(tool));
    part.tag = Some(ordinal);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::Assistant,
        ordinal,
        vec![part],
    )
}

/// The model's reply at `ordinal`, text only.
fn reply(ordinal: u64) -> Entry {
    let mut part = Part::new(
        "p",
        PartBody::Text {
            text: "Done.".into(),
        },
    );
    part.tag = Some(ordinal);
    Entry::new(
        ordinal,
        format!("m{ordinal}"),
        Role::Assistant,
        ordinal,
        vec![part],
    )
}

/// The runner's notice of `entry`, the transcript's newest, handled at `now`.
async fn notice_of(
    session: &mut Session,
    client: &Client,
    settings: &Settings,
    entry: Entry,
    now: u64,
) {
    crate::clock_note::set_test_now(Some(now));
    client.entries.lock().unwrap().push(entry.clone());
    let seq = session.seq + 1;
    let mut request = notice(session, seq, Some(cursor(&entry)));
    request.entries = vec![entry];
    session.notice(client, settings, request).await;
    crate::clock_note::set_test_now(None);
}

/// The clock notes the session sent, as their delivery orders.
fn clock_notes(client: &Client) -> Vec<cortexkit_role_llm_runner::delivery_order::DeliveryOrder> {
    client
        .sent
        .lock()
        .unwrap()
        .iter()
        .filter_map(|request| request.delivery_order().unwrap())
        .filter(|order| {
            order
                .template
                .as_ref()
                .is_some_and(|template| template.id == crate::clock_note::TEMPLATE)
        })
        .collect()
}

/// A session on a runner described by `describe`, its person's first
/// message already in the index.
fn session_on(describe: Value) -> (Session, Client, Route, SetupRequest, Settings) {
    let (mut session, client, route, request, settings) = fixture();
    client.descriptions.lock().unwrap().push_back(Ok(describe));
    let first = text(1, "m1");
    client.entries.lock().unwrap().push(first.clone());
    session.index.extend(vec![first]);
    (session, client, route, request, settings)
}

#[tokio::test]
async fn the_first_tool_turn_gets_a_clock_note_as_a_datetime_template() {
    let (mut session, client, _, _, settings) = session_on(datetime_runner());
    notice_of(&mut session, &client, &settings, tool_call(2), T0 + 59_999).await;
    let notes = clock_notes(&client);
    assert_eq!(notes.len(), 1);
    let note = &notes[0];
    assert_eq!(note.modes, vec![Mode::TurnSystem, Mode::ToolResult]);
    assert_eq!(note.dedupe_key.as_deref(), Some(crate::clock_note::KIND));
    let template = note.template.as_ref().unwrap();
    assert_eq!(template, &crate::clock_note::note(T0 + 59_999));
    // Whole seconds; the runner renders the minute.
    assert_eq!(template.slots["now"], json!(T0 / 1_000 + 59));
    assert_eq!(
        cortexkit_role_llm_runner::delivery_order::render(
            &crate::nudges::templates(),
            template,
            |_| None
        )
        .unwrap(),
        "Now: Wed 18 Nov 22:52Z"
    );
    let sent = client.sent.lock().unwrap();
    assert!(sent[0].send_id.starts_with("mc.clock_note:counter:"));
    assert_eq!(sent[0].prompt, None, "a template send carries no free text");
    drop(sent);
    // Saved with the session.
    assert_eq!(session.durable().clock_note.last_sent_ms, Some(T0 + 59_999));
}

#[tokio::test]
async fn a_runner_without_template_datetime_gets_no_clock_note() {
    for describe in [
        json!({"capabilities": ["delivery_order"]}),
        json!({}),
        json!({"capabilities": ["delivery_order", "template_datetime_v2"]}),
    ] {
        let (mut session, client, _, _, settings) = session_on(describe.clone());
        notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
        notice_of(
            &mut session,
            &client,
            &settings,
            tool_call(3),
            T0 + 120 * MINUTE,
        )
        .await;
        assert!(client.sent.lock().unwrap().is_empty(), "{describe}");
        assert_eq!(session.clock_note, Default::default(), "{describe}");
    }
}

#[tokio::test]
async fn turn_system_is_listed_only_for_a_runner_that_declares_it() {
    for (describe, modes) in [
        (datetime_runner(), vec![Mode::TurnSystem, Mode::ToolResult]),
        (
            json!({
                "capabilities": ["delivery_order", "template_datetime"],
                "delivery_order_modes": ["turn_system", "tool_result"],
            }),
            vec![Mode::TurnSystem, Mode::ToolResult],
        ),
        (
            json!({
                "capabilities": ["delivery_order", "template_datetime"],
                "delivery_order_modes": ["tool_result", "steer"],
            }),
            vec![Mode::ToolResult],
        ),
        (
            json!({"capabilities": ["template_datetime"]}),
            vec![Mode::ToolResult],
        ),
    ] {
        let (mut session, client, _, _, settings) = session_on(describe.clone());
        notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
        let notes = clock_notes(&client);
        assert_eq!(notes.len(), 1, "{describe}");
        assert_eq!(notes[0].modes, modes, "{describe}");
    }
}

#[tokio::test]
async fn a_clock_note_goes_again_only_once_the_interval_has_passed() {
    let (mut session, client, _, _, settings) = session_on(datetime_runner());
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    // Ten minutes later: not due.
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(3),
        T0 + 10 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 1);
    // Thirty minutes after the first: due.
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 30 * MINUTE,
    )
    .await;
    let notes = clock_notes(&client);
    assert_eq!(notes.len(), 2);
    assert_eq!(
        notes[1].template.as_ref(),
        Some(&crate::clock_note::note(T0 + 30 * MINUTE))
    );
    // The interval counts from that one.
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(5),
        T0 + 50 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 2);
}

#[tokio::test]
async fn the_configured_interval_decides_and_false_turns_the_note_off() {
    let (mut session, client, _, _, mut settings) = session_on(datetime_runner());
    settings.clock_note = Some(10 * MINUTE);
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(3),
        T0 + 10 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 2);
    settings.clock_note = None;
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 600 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 2);

    let (mut session, client, _, _, mut settings) = session_on(datetime_runner());
    settings.clock_note = None;
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    assert!(client.sent.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_reply_without_a_tool_call_gets_no_clock_note() {
    let (mut session, client, _, _, settings) = session_on(datetime_runner());
    notice_of(&mut session, &client, &settings, reply(2), T0).await;
    // A person's message is not the model's tool turn either.
    notice_of(&mut session, &client, &settings, text(3, "m3"), T0 + MINUTE).await;
    assert!(clock_notes(&client).is_empty());
    // The first tool turn after them gets one.
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 2 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 1);
}

#[tokio::test]
async fn a_restart_between_notes_sends_no_extra_one() {
    let (mut session, client, route, request, settings) = session_on(datetime_runner());
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    assert_eq!(clock_notes(&client).len(), 1);
    // The saved state, through its stored form, into a new process.
    let saved: crate::store::Durable =
        serde_json::from_str(&serde_json::to_string(&session.durable()).unwrap()).unwrap();
    let mut restarted = Session::new(&route, &request, session.features, None);
    restarted.restore(saved);
    restarted.index = Index::default();
    restarted.index_ready = true;
    let (_, client, _, _, _) = session_on(datetime_runner());
    *client.entries.lock().unwrap() = vec![text(1, "m1"), tool_call(2)];
    restarted.index.extend(vec![text(1, "m1"), tool_call(2)]);
    notice_of(
        &mut restarted,
        &client,
        &settings,
        tool_call(3),
        T0 + 10 * MINUTE,
    )
    .await;
    assert!(clock_notes(&client).is_empty(), "not due after the restart");
    notice_of(
        &mut restarted,
        &client,
        &settings,
        tool_call(4),
        T0 + 30 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 1);
}

#[tokio::test]
async fn a_quiet_free_and_resume_keeps_the_last_note_time() {
    let (mut session, client, _, _, settings) = session_on(datetime_runner());
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    let carry = Box::new(session)
        .quiet_carry()
        .unwrap_or_else(|_| panic!("a quiet session is freed"));
    let mut session = Session::resume_quiet(carry);
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(3),
        T0 + 10 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 1, "not due after the resume");
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 30 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 2);
}

/// The runner refuses the note as naming no template of the session's plan:
/// core composed the plan before the runner declared `template_datetime`.
fn plan_lacks_template() -> crate::client::ClientError {
    crate::client::ClientError {
        detail: Some(json!({"field": "template"})),
        ..crate::client::ClientError::refused("invalid_params", "unknown template")
    }
}

#[tokio::test]
async fn a_plan_without_the_template_stops_notes_until_the_next_setup() {
    let (mut session, client, route, mut request, settings) = session_on(datetime_runner());
    client
        .send_refusals
        .lock()
        .unwrap()
        .push_back(plan_lacks_template());
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    assert_eq!(clock_notes(&client).len(), 1, "one refused send");
    assert!(session.clock_note.refused);
    assert_eq!(session.clock_note.last_sent_ms, None);
    // A later due turn sends nothing, and a restart keeps it so.
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(3),
        T0 + 60 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 1);
    let saved = session.durable();
    assert!(saved.clock_note.refused);
    let mut restarted = Session::new(&route, &request, session.features, None);
    restarted.restore(saved);
    assert!(restarted.clock_note.refused);
    // A new Setup clears it: the plan may hold the template now.
    request.newest = client.entries.lock().unwrap().last().map(cursor);
    session
        .setup(&client, &settings, &route, &request, session.features)
        .await;
    assert!(!session.clock_note.refused);
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 61 * MINUTE,
    )
    .await;
    let notes = clock_notes(&client);
    assert_eq!(notes.len(), 2, "the next due turn sends again");
    assert_eq!(session.clock_note.last_sent_ms, Some(T0 + 61 * MINUTE));
}

#[tokio::test]
async fn other_send_failures_leave_the_note_due() {
    let (mut session, client, _, _, settings) = session_on(datetime_runner());
    client.send_refusals.lock().unwrap().extend([
        crate::client::ClientError {
            detail: Some(json!({"delivery": ["turn_system", "tool_result"]})),
            ..crate::client::ClientError::refused("delivery_unsupported", "no mode")
        },
        crate::client::ClientError::new("connection lost"),
    ]);
    notice_of(&mut session, &client, &settings, tool_call(2), T0).await;
    notice_of(&mut session, &client, &settings, tool_call(3), T0 + MINUTE).await;
    assert_eq!(session.clock_note, Default::default());
    notice_of(
        &mut session,
        &client,
        &settings,
        tool_call(4),
        T0 + 2 * MINUTE,
    )
    .await;
    assert_eq!(clock_notes(&client).len(), 3);
    assert_eq!(session.clock_note.last_sent_ms, Some(T0 + 2 * MINUTE));
}
