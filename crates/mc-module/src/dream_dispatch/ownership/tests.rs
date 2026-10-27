use super::*;
use crate::historian_runner::HistorianRunnerKind;
use std::collections::BTreeSet;

/// A wiring that names every task with a Rust host (Broca transport off), so a
/// test can exercise publication the production wiring does not allow yet.
pub(crate) fn every_hosted_task() -> Wiring {
    Wiring {
        tasks: CANONICAL_TASKS
            .into_iter()
            .filter(|task| task_roles(*task).is_some())
            .collect(),
        broca: false,
        broca_file_read: false,
    }
}

fn host_config() -> McModuleConfig {
    McModuleConfig {
        rust_background_enabled: true,
        ..Default::default()
    }
}

fn names(tasks: &[TaskName]) -> Vec<&'static str> {
    tasks.iter().map(|t| t.as_str()).collect()
}

/// The production wiring names exactly the tasks with an end-to-end Rust path
/// (`dispatcher::OPERATIONAL_TASKS`); a runner lane able to carry every role
/// still gets nothing else, and every other hosted task stays `host_unwired`.
#[test]
fn production_wiring_publishes_only_the_operational_tasks() {
    let settings = json!({"dreamer": {
        "opencode": {"model": "provider/model"},
        "opencode2": {"model": "provider/model"},
    }});
    let operational: Vec<TaskName> = CANONICAL_TASKS
        .into_iter()
        .filter(|t| super::super::dispatcher::OPERATIONAL_TASKS.contains(t))
        .collect();
    assert_eq!(
        operational,
        [
            TaskName::Map,
            TaskName::Verify,
            TaskName::VerifyBroad,
            TaskName::Curate,
            TaskName::Classify,
            TaskName::ReviewUserMemories
        ]
    );
    for harness in ["opencode", "opencode2"] {
        let reading = Wiring {
            broca_file_read: true,
            ..Wiring::production()
        };
        let ownership = publish_on(
            &OwnershipInput {
                config: &host_config(),
                settings: Some(&settings),
                harness,
                wiring: &reading,
            },
            Some(true),
        );
        assert!(ownership.activated);
        assert_eq!(ownership.published, operational, "{harness}");
        for (task, reason) in &ownership.withheld {
            if task_roles(*task).is_some() {
                assert_eq!(reason, "host_unwired", "{harness} {task:?}");
            }
        }
        // Off a runner lane the host runner has no carrier: nothing is published.
        let alone = publish(&OwnershipInput {
            config: &host_config(),
            settings: Some(&settings),
            harness,
            wiring: &Wiring::production(),
        });
        assert_eq!(alone.published, Vec::<TaskName>::new(), "{harness}");
    }
}

/// A configured Broca runner gets the file-reading tasks only when it is known
/// to admit AFT's read tools. Production cannot know that yet, so a production
/// Broca wiring publishes only the memory-only operational tasks.
#[test]
fn broca_publishes_file_reading_tasks_only_when_it_declares_file_reads() {
    let settings = json!({"dreamer": {"claude-code": {"model": "anthropic/claude-sonnet-4-5"}}});
    let configured = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Broca),
        ..host_config()
    };
    let production = Wiring {
        broca: true,
        ..Wiring::production()
    };
    assert!(!production.broca_file_read);
    let memory_only = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &production,
    });
    assert_eq!(
        memory_only.published,
        [
            TaskName::Curate,
            TaskName::Classify,
            TaskName::ReviewUserMemories
        ]
    );
    for task in [TaskName::Map, TaskName::Verify, TaskName::VerifyBroad] {
        assert!(memory_only
            .withheld
            .contains(&(task, "broca_file_read".into())));
    }
    let reading = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &Wiring {
            broca_file_read: true,
            ..production
        },
    });
    assert_eq!(
        reading.published,
        [
            TaskName::Map,
            TaskName::Verify,
            TaskName::VerifyBroad,
            TaskName::Curate,
            TaskName::Classify,
            TaskName::ReviewUserMemories
        ]
    );
}

#[test]
fn switch_off_publishes_nothing() {
    let settings =
        json!({"dreamer": {"opencode": {"model": "anthropic/claude-sonnet-4-5"}, "tasks": {}}});
    let ownership = publish(&OwnershipInput {
        config: &McModuleConfig::default(),
        settings: Some(&settings),
        harness: "opencode",
        wiring: &every_hosted_task(),
    });
    assert!(!ownership.activated);
    assert!(ownership.published.is_empty());
    assert!(ownership.withheld.iter().all(|(_, r)| r == "inactive"));
}

#[test]
fn host_runner_without_a_declared_claimant_publishes_nothing() {
    let settings =
        json!({"dreamer": {"opencode": {"model": "anthropic/claude-sonnet-4-5"}, "tasks": {}}});
    let ownership = publish(&OwnershipInput {
        config: &host_config(),
        settings: Some(&settings),
        harness: "opencode",
        wiring: &every_hosted_task(),
    });
    assert!(ownership.published.is_empty());
    assert!(ownership
        .withheld
        .contains(&(TaskName::Curate, "no_claimant".into())));
}

#[test]
fn unresolvable_trusted_config_publishes_nothing() {
    let ownership = publish_on(
        &OwnershipInput {
            config: &host_config(),
            settings: None,
            harness: "opencode",
            wiring: &every_hosted_task(),
        },
        Some(true),
    );
    assert!(ownership.published.is_empty());
}

#[test]
fn broca_is_chosen_only_when_the_user_configured_it() {
    let settings = json!({"dreamer": {"claude-code": {"model": "anthropic/claude-sonnet-4-5"}}});
    let no_models = json!({"dreamer": {}});
    let mut wiring = every_hosted_task();
    // claude-code's default runner is Broca, but the user named none: nothing is
    // published, whatever is wired.
    let defaulted = publish(&OwnershipInput {
        config: &host_config(),
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &Wiring {
            broca: true,
            ..wiring.clone()
        },
    });
    assert!(defaulted.published.is_empty());
    assert!(defaulted
        .withheld
        .contains(&(TaskName::Curate, "broca_not_configured".into())));

    let configured = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Broca),
        ..host_config()
    };
    let unwired = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &wiring,
    });
    assert!(unwired.published.is_empty());
    assert!(unwired
        .withheld
        .contains(&(TaskName::Curate, "broca_unwired".into())));

    wiring.broca = true;
    // This test is about runner choice, so the runner also declares file reads
    // and every hosted task can be carried.
    wiring.broca_file_read = true;
    let wired = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &wiring,
    });
    assert_eq!(wired.published, wiring.tasks);
    let modelless = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&no_models),
        harness: "claude-code",
        wiring: &wiring,
    });
    assert!(modelless.published.is_empty());
    assert!(modelless
        .withheld
        .contains(&(TaskName::Curate, "broca_model_required".into())));
}

/// The roles in `task_roles` are the roles each host actually opens children
/// for. Read from the hosts' (and their task modules') non-test source.
#[test]
fn task_roles_match_the_roles_each_host_opens() {
    let production = |source: &'static str| source.split("#[cfg(test)]").next().unwrap();
    let hosts: [(&str, &str, &[TaskName]); 5] = [
        (
            "dream_tasks/classify.rs",
            production(include_str!("../../dream_tasks/classify.rs")),
            &[TaskName::Classify, TaskName::Map],
        ),
        (
            "dream_dispatch/verify_host.rs",
            production(include_str!("../verify_host.rs")),
            &[TaskName::Verify, TaskName::VerifyBroad],
        ),
        (
            "dream_tasks/curate.rs",
            production(include_str!("../../dream_tasks/curate.rs")),
            &[TaskName::Curate],
        ),
        (
            "dream_dispatch/retrospective_host.rs",
            production(include_str!("../retrospective_host.rs")),
            &[TaskName::Retrospective, TaskName::ReviewUserMemories],
        ),
        (
            "dream_dispatch/primer_host.rs",
            production(include_str!("../primer_host.rs")),
            &[TaskName::PromotePrimers, TaskName::RefreshPrimers],
        ),
    ];
    let all = [
        DreamRole::Classifier,
        DreamRole::MemoryMapper,
        DreamRole::Curate,
        DreamRole::Docs,
        DreamRole::Reviewer,
        DreamRole::PrimerInvestigator,
        DreamRole::Retrospective,
    ];
    for (file, source, tasks) in hosts {
        let opened: BTreeSet<String> = all
            .iter()
            .filter(|role| source.contains(&format!("DreamRole::{role:?}")))
            .map(|role| format!("{role:?}"))
            .collect();
        let declared: BTreeSet<String> = tasks
            .iter()
            .flat_map(|task| task_roles(*task).unwrap().iter())
            .map(|role| format!("{role:?}"))
            .collect();
        assert_eq!(opened, declared, "{file}");
    }
}

/// A project whose children run on a runner-lane conversation's own runner needs
/// neither a host claimant nor a configured Broca runner: with an unset or `host`
/// dreamer runner on OpenCode, the memory-only operational tasks are published
/// with no claimant declared. File-reading tasks keep Broca's file-read gate.
#[test]
fn a_session_runner_lane_publishes_without_a_claimant_or_configured_broca() {
    let settings = json!({"dreamer": {"opencode": {"model": "provider/model"}}});
    let explicit_host = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Host),
        ..host_config()
    };
    for config in [host_config(), explicit_host] {
        let input = OwnershipInput {
            config: &config,
            settings: Some(&settings),
            harness: "opencode",
            wiring: &Wiring::production(),
        };
        // Off the runner lane the host runner has no carrier.
        assert!(publish(&input).published.is_empty());
        let lane = publish_on(&input, Some(true));
        assert_eq!(
            lane.published,
            [
                TaskName::Curate,
                TaskName::Classify,
                TaskName::ReviewUserMemories
            ]
        );
        for task in [TaskName::Map, TaskName::Verify, TaskName::VerifyBroad] {
            assert!(lane
                .withheld
                .contains(&(task, "session_runner_file_read".into())));
        }
        let unwired = publish_on(&input, Some(false));
        assert!(unwired.published.is_empty());
        assert!(unwired
            .withheld
            .iter()
            .any(|(_, reason)| reason == "session_runner_unwired"));
    }
    let no_model = publish_on(
        &OwnershipInput {
            config: &host_config(),
            settings: Some(&json!({})),
            harness: "opencode",
            wiring: &Wiring::production(),
        },
        Some(true),
    );
    assert!(no_model.published.is_empty());
}
