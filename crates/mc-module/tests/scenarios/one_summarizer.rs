//! The summarizer has one shape: the two-turn historian. A session without a
//! project runs its first turn and publishes the summaries, but sends no
//! second turn: its facts have no project to become memories in, which is
//! what the second turn writes. A model whose first turn gives no valid reply
//! hands the run to the next model routing picks, which gets the same
//! two-turn first turn.

use super::*;

/// The scripted summarizer, with one anchored fact on every first turn, so a
/// session with a project would have a candidate for a second turn.
fn summarizer_with_a_fact() -> mc_mock_runner::child::Responder {
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    std::sync::Arc::new(move |settings, prompt| {
        use mc_mock_runner::child as mock;
        let mut reply = summarizer(settings, prompt);
        if prompt.contains(mock::TURN_ONE_FORMAT) {
            let xml = mock::summarize(prompt).replace(
                "</output>",
                "<facts><PROJECT_RULES>\n* [at_compartment=1 messages=1] Releases need two reviewers.\n</PROJECT_RULES></facts>\n</output>",
            );
            reply.text = mock::turn_one_reply(&xml);
        }
        reply
    })
}

/// Three short turns and one more answer. A summary is shown only when ck-mc
/// publishes a new view, which happens on a later request, so the extra
/// answer gives the third turn's summary that request.
fn three_turns() -> Vec<Step> {
    let mut steps = Vec::new();
    for prompt in ["Look at a.rs.", "Now b.rs.", "And c.rs."] {
        steps.extend(turn(prompt));
    }
    steps.push(answer());
    steps
}

fn assert_summaries_shown(host: &Host) {
    let (m0, m1) = head_texts(host);
    assert!(
        m0.contains("<session-history>\n") || m1.contains("<new-compartments>"),
        "{m0}\n{m1}"
    );
}

#[tokio::test]
async fn a_project_less_session_summarizes_on_the_two_turn_prompt_and_sends_no_turn_two() {
    let dir = scratch("one-summarizer-no-project");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let config = config("head", Kind::OpenAi, free());
    assert!(config.project.is_none());
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    runner.host().set_responder(summarizer_with_a_fact());
    runner.play(&three_turns()).await;
    assert_clean(&runner);
    let runs = runner.host().child_runs();
    let first_turns: Vec<_> = runs
        .iter()
        .filter(|run| run.prompt.contains("<new_messages>"))
        .collect();
    assert!(!first_turns.is_empty(), "no summary ran");
    for run in &first_turns {
        assert!(
            run.prompt.contains(mc_mock_runner::child::TURN_ONE_FORMAT),
            "{}",
            run.prompt
        );
        assert_eq!(
            run.settings.system,
            mc_module::summary::two_pass::turn_one::SYSTEM
        );
    }
    assert!(
        !runs
            .iter()
            .any(|run| run.prompt.contains(mc_mock_runner::child::TURN_TWO_FACT)),
        "a second turn was sent"
    );
    assert_summaries_shown(runner.host());
    // Without a project nothing was recorded for a second turn.
    let conn = rusqlite::Connection::open(dir.join("context.db")).unwrap();
    let stages: i64 = conn
        .query_row("SELECT COUNT(*) FROM memory_stage_attempts", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(stages, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_invalid_first_turn_moves_to_the_next_model_on_the_two_turn_prompt() {
    let dir = scratch("one-summarizer-fallback");
    ContextDb::create_for_tests(&dir.join("context.db")).unwrap();
    let mut config = config("head", Kind::OpenAi, free());
    config.project = Some(mc_mock_runner::runner::Project {
        id: "pj-test".into(),
        root: dir.to_string_lossy().into_owned(),
    });
    let mut runner = start_full(config, Settings::default(), Some(dir.clone())).await;
    runner.provider().client.routing.lock().unwrap().routes =
        vec!["broken/model".into(), "good/model".into()];
    let summarizer = mc_mock_runner::child::scripted_summarizer();
    runner
        .host()
        .set_responder(std::sync::Arc::new(move |settings, prompt| {
            if settings.model.provider == "broken" {
                mc_mock_runner::child::Reply {
                    text: "not a turn-one envelope".into(),
                    finish: Some("stop".into()),
                    error: None,
                }
            } else {
                summarizer(settings, prompt)
            }
        }));
    runner.play(&three_turns()).await;
    assert_clean(&runner);
    let log = runner.provider().client.routing.lock().unwrap();
    // The run that met the invalid reply asked routing again, without the
    // model that gave it, instead of ending.
    assert!(log.selects.len() >= 2, "{} selects", log.selects.len());
    assert_eq!(
        log.selects[1].exclude,
        Some(vec!["broken/model".to_owned()])
    );
    drop(log);
    let runs = runner.host().child_runs();
    assert!(
        runs.iter().all(|run| !run.child.ends_with(":repair")),
        "a repair run was sent"
    );
    let first_turns: Vec<_> = runs
        .iter()
        .filter(|run| run.prompt.contains("<new_messages>"))
        .collect();
    assert!(first_turns
        .iter()
        .any(|run| run.settings.model.provider == "good"));
    for run in &first_turns {
        assert!(
            run.prompt.contains(mc_mock_runner::child::TURN_ONE_FORMAT),
            "{}",
            run.prompt
        );
        assert_eq!(
            run.settings.system,
            mc_module::summary::two_pass::turn_one::SYSTEM
        );
    }
    assert_summaries_shown(runner.host());
    let _ = std::fs::remove_dir_all(&dir);
}
