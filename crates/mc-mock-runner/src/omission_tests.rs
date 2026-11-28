use super::*;
use cortexkit_role_compaction::part::{Part, ToolPart};
use cortexkit_role_compaction::read::Role;
use cortexkit_role_compaction::tokens::PartTokens;

async fn run(declared: bool) -> Runner<TestProvider> {
    let mut provider = TestProvider::new();
    provider.omission = declared;
    let runner = Runner::start(config(Kind::OpenAi, free(), 100_000), provider)
        .await
        .unwrap();
    runner.provider().attach(runner.host().clone());
    runner
}

fn text(id: &str, text: &str) -> Part {
    Part::new(id, PartBody::Text { text: text.into() })
}

#[tokio::test]
async fn explicitly_marked_stored_parts_follow_the_setup_declaration_and_wire_plan() {
    for declared in [false, true] {
        let mut runner = run(declared).await;
        let mut cut = text("cut", "the unexecuted continuation");
        cut.omitted = true;
        cut.tokens = Some(PartTokens::count(40));
        runner
            .play(&[
                user("begin"),
                Step::Record {
                    role: Role::Assistant,
                    parts: vec![cut],
                },
                user("follow up"),
            ])
            .await;
        let stored = runner.host().entries();
        let cut = &stored[1].parts[0];
        assert_eq!(cut.omitted, declared);
        assert_eq!(cut.tag, (!declared).then_some(2));
        assert_eq!(cut.tokens, (!declared).then_some(PartTokens::count(40)));
        assert_eq!(stored[2].parts[0].tag, Some(if declared { 2 } else { 3 }));
        let notices = runner.provider().notices.lock().unwrap();
        assert_eq!(notices[1].entries[0].parts[0].omitted, declared);
        assert_eq!(
            runner
                .host()
                .rendered()
                .iter()
                .any(|msg| msg.parts.iter().any(|part| part.id == "cut")),
            !declared
        );
    }
}

fn running() -> Step {
    Step::Record {
        role: Role::Assistant,
        parts: vec![Part::new(
            "probe",
            PartBody::Tool(ToolPart::new(
                "probe",
                "read",
                json!({"path":"file.rs"}),
                ToolStatus::Running,
            )),
        )],
    }
}

fn settle() -> Step {
    Step::SettleOmitted {
        call_id: "probe".into(),
    }
}

#[tokio::test]
async fn a_scripted_settlement_resends_the_recounted_suffix_only_with_the_declaration() {
    for declared in [false, true] {
        let mut runner = run(declared).await;
        runner
            .play(&[user("begin"), running(), user("later"), settle()])
            .await;
        assert!(runner.report.refusals.is_empty());
        let entries = runner.host().entries();
        assert_eq!(entries[1].parts[0].omitted, declared);
        assert_eq!(entries[1].parts[0].tag, (!declared).then_some(2));
        assert_eq!(entries[2].parts[0].tag, Some(if declared { 2 } else { 3 }));
        let notices = runner.provider().notices.lock().unwrap();
        let settled = notices.last().unwrap();
        assert_eq!(
            settled
                .entries
                .iter()
                .map(|entry| entry.ordinal)
                .collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(
            settled
                .events
                .contains(&Event::TranscriptChanged { from_ordinal: 2 }),
            declared
        );
        assert_ne!(
            notices[1].entries[0].parts[0].digest,
            settled.entries[0].parts[0].digest
        );
        assert_eq!(
            notices[2].entries[0].digest == settled.entries[1].digest,
            !declared
        );
    }
}

#[tokio::test]
async fn scripted_settlement_refuses_if_a_later_number_was_sent() {
    let mut runner = run(true).await;
    runner
        .play(&[user("begin"), running(), user("later"), answer(), settle()])
        .await;
    assert!(runner.report.model_errors.is_empty());
    assert_eq!(runner.report.requests.len(), 1);
    assert_eq!(runner.report.refusals.len(), 1);
    assert!(runner.report.refusals[0].contains("a later number was already rendered"));
    let entries = runner.host().entries();
    assert!(!entries[1].parts[0].omitted);
    assert_eq!(entries[2].parts[0].tag, Some(3));
}
