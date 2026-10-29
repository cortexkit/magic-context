//! The dream tasks this build runs, one registration each.
//!
//! A task becomes runnable by adding its registration here, next to its host;
//! nothing else in the dispatcher lists tasks. Each registration names the task's
//! routing consumer (`mc.dream.<task>`, dotted so routing configuration can be
//! inherited along the dots) and the demand ck-mc states for it by default, so a
//! user never has to configure a task to get a sensible model. Anyone who wants a
//! different model for one task pins that task's consumer in routing.

use mc_store::dream_scheduler::schedules::TaskName;

/// One runnable dream task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DreamTaskRegistration {
    pub task: TaskName,
    /// The routing consumer this task selects as.
    pub consumer: &'static str,
    /// Default `iq` demand, 0-100.
    pub iq: u8,
    /// Default `eq` demand, where the task's output depends on judging people's
    /// intent rather than facts.
    pub eq: Option<u8>,
}

/// Every task with a production executor that applies its effects end to end.
///
/// Curate, classify and review-user-memories have end-to-end tests through
/// the Broca executor. map-memories, verify and verify-broad also read the
/// repository; their tests run through the same executor with the
/// fake Broca reading a fixture repository (`broca_carrier::tests::executor`).
/// Classify also runs end to end through the routed carrier, and the carrier
/// itself is tested on a curate context (`broca_carrier::tests::routed`).
pub const REGISTRATIONS: [DreamTaskRegistration; 6] = [
    DreamTaskRegistration {
        task: TaskName::Curate,
        consumer: "mc.dream.curate",
        iq: 70,
        eq: None,
    },
    DreamTaskRegistration {
        task: TaskName::Classify,
        consumer: "mc.dream.classify-memories",
        iq: 50,
        eq: None,
    },
    DreamTaskRegistration {
        task: TaskName::ReviewUserMemories,
        consumer: "mc.dream.review-user-memories",
        iq: 50,
        eq: Some(60),
    },
    DreamTaskRegistration {
        task: TaskName::Map,
        consumer: "mc.dream.map-memories",
        iq: 50,
        eq: None,
    },
    DreamTaskRegistration {
        task: TaskName::Verify,
        consumer: "mc.dream.verify",
        iq: 70,
        eq: None,
    },
    DreamTaskRegistration {
        task: TaskName::VerifyBroad,
        consumer: "mc.dream.verify-broad",
        iq: 70,
        eq: None,
    },
];

const fn tasks<const N: usize>(registrations: &[DreamTaskRegistration; N]) -> [TaskName; N] {
    let mut out = [TaskName::Curate; N];
    let mut index = 0;
    while index < N {
        out[index] = registrations[index].task;
        index += 1;
    }
    out
}

/// The registered tasks, in registration order.
pub const OPERATIONAL_TASKS: &[TaskName] = &tasks(&REGISTRATIONS);

/// The registration of `task`, or `None` when this build does not run it.
pub fn registration(task: TaskName) -> Option<&'static DreamTaskRegistration> {
    REGISTRATIONS.iter().find(|r| r.task == task)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_task_selects_as_its_own_dotted_consumer() {
        for registration in REGISTRATIONS {
            assert_eq!(
                registration.consumer,
                format!("mc.dream.{}", registration.task.as_str())
            );
            assert!(registration.iq <= 100 && registration.eq.is_none_or(|eq| eq <= 100));
        }
        let mut consumers: Vec<_> = REGISTRATIONS.iter().map(|r| r.consumer).collect();
        consumers.dedup();
        assert_eq!(consumers.len(), REGISTRATIONS.len());
        assert_eq!(OPERATIONAL_TASKS.len(), REGISTRATIONS.len());
        assert!(OPERATIONAL_TASKS
            .iter()
            .all(|task| registration(*task).is_some()));
    }
}
