//! The clock note against the mock runner: a runner that renders datetime
//! templates gets `Now: <time>` on the agent's first tool turn, riding the
//! new tool result, and nothing already served changes for it.

use super::*;
use cortexkit_compaction_view::render::RenderedMessage;

/// Declare `template_datetime` on the runner, as an upgrade would, and let
/// ck-mc read the runner's declaration again, as it does after a Setup.
fn declare_template_datetime(runner: &Runner<InProcess>) {
    runner.host().declare_template_datetime(true);
    runner
        .provider()
        .client
        .runner_capabilities
        .forget("mock-runner");
}

/// The clock notes delivered with tool results, oldest first: the template
/// each was rendered from and its text.
fn clock_notes(host: &Host) -> Vec<(Option<String>, String)> {
    host.entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .filter_map(|part| match &part.body {
            PartBody::Tool(tool) => tool.delivered(),
            _ => None,
        })
        .flatten()
        .filter(|item| item.sender == "magic-context")
        .filter(|item| item.template.as_deref() == Some(mc_module::clock_note::TEMPLATE))
        .map(|item| {
            (
                item.template.clone(),
                item.text
                    .as_ref()
                    .map(|text| text.to_string())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

/// `Now: Ddd DD Mon HH:MMZ`, as the runner renders a `utc_minute` slot.
fn is_clock_text(text: &str) -> bool {
    let Some(time) = text.strip_prefix("Now: ") else {
        return false;
    };
    let bytes = time.as_bytes();
    time.len() == 17
        && bytes[3] == b' '
        && bytes[4..6].iter().all(u8::is_ascii_digit)
        && bytes[6] == b' '
        && bytes[10] == b' '
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b':'
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[16] == b'Z'
}

fn read_step() -> Step {
    Step::Model(Turn {
        text: Some("Reading the next file.".into()),
        tools: vec![ToolCall::ok(
            "read",
            json!({"path": "a.rs"}),
            "fn main() {}\n".repeat(20),
        )],
        output_tokens: 20,
        ..Turn::default()
    })
}

fn assert_prefix_unchanged(before: &[RenderedMessage], after: &[RenderedMessage]) {
    assert!(after.len() > before.len());
    for (index, (old, new)) in before.iter().zip(after).enumerate() {
        assert_eq!(
            serde_json::to_vec(old).unwrap(),
            serde_json::to_vec(new).unwrap(),
            "message {index} changed after it was served"
        );
    }
}

#[tokio::test]
async fn a_clock_note_lands_as_a_datetime_template_on_a_new_tool_result() {
    let mut runner = start(config("worker", Kind::Anthropic, free())).await;
    declare_template_datetime(&runner);
    runner.play(&[user("Survey the repository.")]).await;
    let served = runner.host().rendered();
    runner.play(&[read_step()]).await;
    assert_clean(&runner);
    let host = runner.host();
    let notes = clock_notes(host);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(is_clock_text(&notes[0].1), "{notes:?}");
    // It rides the result of the tool call ck-mc saw, the newest message.
    let entries = host.entries();
    let carrier = entries.last().unwrap();
    assert!(carrier.parts.iter().any(|part| match &part.body {
        PartBody::Tool(tool) => tool
            .delivered()
            .is_some_and(|items| items.iter().any(|item| item.template.is_some())),
        _ => false,
    }));
    let with_note = host.rendered();
    assert_prefix_unchanged(&served, &with_note);

    // More tool turns within the interval get none, and the note stays as
    // it was delivered: the history keeps it.
    runner.play(&[read_step(), read_step(), answer()]).await;
    assert_clean(&runner);
    let host = runner.host();
    assert_eq!(clock_notes(host), notes);
    assert_prefix_unchanged(&with_note, &host.rendered());
}

#[tokio::test]
async fn a_runner_without_template_datetime_gets_no_clock_note() {
    let mut runner = start(config("worker", Kind::Anthropic, free())).await;
    runner
        .play(&[user("Survey the repository."), read_step(), answer()])
        .await;
    assert_clean(&runner);
    assert!(clock_notes(runner.host()).is_empty());
    assert!(runner
        .host()
        .entries()
        .iter()
        .flat_map(|entry| &entry.parts)
        .all(|part| match &part.body {
            PartBody::Tool(tool) => tool.delivered().is_none_or(<[_]>::is_empty),
            _ => true,
        }));
}

#[tokio::test]
async fn the_summarizer_s_child_sessions_never_get_a_clock_note() {
    let mut runner = start(config("head", Kind::OpenAi, free())).await;
    declare_template_datetime(&runner);
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    runner.play(&steps).await;
    assert_clean(&runner);
    let host = runner.host();
    let runs = host.child_runs();
    assert!(!runs.is_empty(), "no summarizer run");
    for run in &runs {
        assert!(
            run.request.delivery_order().unwrap().is_none(),
            "{}",
            run.child
        );
        assert!(!run.prompt.contains("Now: "), "{}", run.child);
    }
    // The head itself got its note on its first tool turn.
    assert_eq!(clock_notes(host).len(), 1);
}
