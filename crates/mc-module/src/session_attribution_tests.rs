//! A session hands its route's agent to the summary runs it starts, so their
//! child sessions' attribution facts name the agent the summary was for.

use super::*;
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::ModelRef;

fn session(agent_id: Option<&str>) -> Session {
    let route = Route {
        session: SessionRef::new("broca", "pi", "head"),
        project: Some(Project {
            id: "pj-attributed".into(),
            root: "/project".into(),
        }),
        workdir: Some("/project".into()),
        agent_id: agent_id.map(str::to_owned),
    };
    let request = SetupRequest::new(
        "attribution-test",
        ModelRef::new("test", "model"),
        100_000,
        0,
        ProviderRules::new(SignedParts::None, EditCost::Suffix),
        Vec::new(),
        1,
    );
    let features = crate::preset::Features {
        summarizer: true,
        ..crate::preset::Features::NONE
    };
    Session::new(&route, &request, features, None)
}

fn continuation() -> run::Continuation {
    run::Continuation {
        prompts: crate::summary::prompts::SummaryPrompts::bundled(),
        keep_child: false,
        child: crate::client::Child {
            session: SessionRef::new("broca", "pi", "head:mc-summary:child"),
            project_root: Some("/project".into()),
        },
        model: ModelRef::new("provider", "model"),
        decision_id: "decision".into(),
        output_tokens: 1_000,
        history: None,
        language: None,
        publication_id: "publication".into(),
    }
}

#[test]
fn the_routes_agent_reaches_both_summary_turns() {
    let settings = Settings::default();
    let mut head = session(Some("agent_alfonso"));
    let request = head.begin_summary(&settings, 0, 1, false, false);
    assert_eq!(request.agent_id.as_deref(), Some("agent_alfonso"));
    assert_eq!(request.project.as_deref(), Some("pj-attributed"));
    let job = head.turn_two_job(&settings, continuation()).unwrap();
    assert_eq!(job.agent_id.as_deref(), Some("agent_alfonso"));

    let mut unnamed = session(None);
    assert_eq!(
        unnamed
            .begin_summary(&settings, 0, 1, false, false)
            .agent_id,
        None
    );
}
