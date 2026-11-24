//! A stand-in for Entorhinal's role leases, for tests: each watch it opens
//! delivers notices taken from Entorhinal's published samples
//! (`testdata/role-lease-v1.5`, Entorhinal tag `role-lease-v1.5`), a test
//! can send more into a watch that is open, and each yield gets the next
//! answer a test queued for its role. It records every watch opened and
//! closed, every acknowledgement and every yield.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use super::lease::{
    AckAnswer, Clock, LeaseError, LeaseRoute, Notice, Notices, RoleLeases, Watch, YieldAnswer,
};

/// The published samples, by file name, as their `SHA256SUMS` lists them.
pub(crate) const SAMPLES: [(&str, &str); 11] = [
    (
        "ack.json",
        include_str!("../../testdata/role-lease-v1.5/ack.json"),
    ),
    (
        "handback.json",
        include_str!("../../testdata/role-lease-v1.5/handback.json"),
    ),
    (
        "holding.json",
        include_str!("../../testdata/role-lease-v1.5/holding.json"),
    ),
    (
        "hub-first-take.json",
        include_str!("../../testdata/role-lease-v1.5/hub-first-take.json"),
    ),
    (
        "lapsed.json",
        include_str!("../../testdata/role-lease-v1.5/lapsed.json"),
    ),
    (
        "local-after-hub.json",
        include_str!("../../testdata/role-lease-v1.5/local-after-hub.json"),
    ),
    (
        "not-holding.json",
        include_str!("../../testdata/role-lease-v1.5/not-holding.json"),
    ),
    (
        "refusals.json",
        include_str!("../../testdata/role-lease-v1.5/refusals.json"),
    ),
    (
        "sharing-disabled.json",
        include_str!("../../testdata/role-lease-v1.5/sharing-disabled.json"),
    ),
    (
        "yield-transferred.json",
        include_str!("../../testdata/role-lease-v1.5/yield-transferred.json"),
    ),
    (
        "yield-withdrawn.json",
        include_str!("../../testdata/role-lease-v1.5/yield-withdrawn.json"),
    ),
];

pub(crate) const SHA256SUMS: &str = include_str!("../../testdata/role-lease-v1.5/SHA256SUMS");

/// One request a sample records: the op, its params, the principal its
/// route was bound to, and every frame the handler served.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Record {
    pub op: String,
    pub request: Value,
    pub principal: Value,
    pub frames: Vec<Frame>,
}

/// One frame as the samples show it: its type and its body.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", content = "body", deny_unknown_fields)]
pub(crate) enum Frame {
    StreamData(Notice),
    /// The end of a watch; its body is empty (`null`).
    StreamEnd(()),
    Error(LeaseError),
    Response(Answer),
}

/// The answer a `Response` frame carries: to an acknowledgement or to a
/// yield.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum Answer {
    Ack(AckAnswer),
    Yield(YieldAnswer),
}

/// The records of sample `file`.
pub(crate) fn records(file: &str) -> Vec<Record> {
    let (_, text) = SAMPLES
        .iter()
        .find(|(name, _)| *name == file)
        .unwrap_or_else(|| panic!("no sample {file}"));
    serde_json::from_str(text).unwrap_or_else(|error| panic!("{file}: {error}"))
}

/// The notices sample `file` records for `role`'s watch, in order.
pub(crate) fn notices(file: &str, role: &str) -> Vec<Notice> {
    let notices: Vec<Notice> = records(file)
        .into_iter()
        .filter(|record| record.op == super::lease::LEASE_OP && record.request["role"] == role)
        .flat_map(|record| record.frames)
        .filter_map(|frame| match frame {
            Frame::StreamData(notice) => Some(notice),
            _ => None,
        })
        .collect();
    assert!(!notices.is_empty(), "{file} records no notice for {role}");
    notices
}

/// The answer sample `file` records for its yield: `true` when the role
/// was handed over.
pub(crate) fn yielded(file: &str) -> bool {
    records(file)
        .into_iter()
        .filter(|record| record.op == super::lease::YIELD_OP)
        .flat_map(|record| record.frames)
        .find_map(|frame| match frame {
            Frame::Response(Answer::Yield(answer)) => Some(answer.result.yielded),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{file} records no yield answer"))
}

/// What a watch delivers next.
#[derive(Clone, Debug)]
pub(crate) enum Step {
    Notice(Notice),
    /// The watch ends.
    End,
    /// The watch ends on a refusal.
    Refuse(LeaseError),
}

/// What the stand-in saw.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Log {
    /// Each watch opened, by role.
    pub opened: Vec<String>,
    /// Each acknowledgement: the role and the notice's sequence number.
    pub acks: Vec<(String, u64)>,
    /// Each yield: the role and the generation it was offered at.
    pub yields: Vec<(String, u64)>,
    /// Each watch closed, by role.
    pub closed: Vec<String>,
}

#[derive(Default)]
struct Shared {
    log: Log,
    /// The open watches, by role, for [`SampleLeases::send`].
    live: HashMap<String, mpsc::UnboundedSender<Step>>,
    /// The answers the next yields of each role get, in order. A yield
    /// with none queued gets no answer at all.
    yields: HashMap<String, VecDeque<Result<bool, LeaseError>>>,
}

/// The stand-in. A role with no script of its own gets the default one; a
/// role with neither gets a watch that delivers nothing until a test sends
/// it something.
#[derive(Default)]
pub(crate) struct SampleLeases {
    scripts: Mutex<HashMap<String, Vec<Step>>>,
    default: Mutex<Vec<Step>>,
    refusals: Mutex<HashMap<String, LeaseError>>,
    /// When set, each watch's notices are moved in time so the first is
    /// issued at this clock's reading when the watch opens, keeping their
    /// spacing: samples recorded on Entorhinal's simulated clock then grant
    /// the same windows on a real one.
    rebase: Option<Clock>,
    shared: Arc<Mutex<Shared>>,
}

impl SampleLeases {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every role granted as a single computer grants it: the notices
    /// `sharing-disabled.json` records for `dreamer.global` (gen 1,
    /// 45-second windows), issued as each watch opens on the system's
    /// monotonic clock.
    pub(crate) fn granting() -> Arc<Self> {
        let leases = Self {
            rebase: Some(super::lease::system_clock()),
            ..Self::default()
        };
        *leases.default.lock().unwrap() = notices("sharing-disabled.json", "dreamer.global")
            .into_iter()
            .map(Step::Notice)
            .collect();
        Arc::new(leases)
    }

    /// Every watch opened for `role` delivers `steps` at once.
    pub(crate) fn script(&self, role: &str, steps: Vec<Step>) {
        self.scripts.lock().unwrap().insert(role.to_owned(), steps);
    }

    /// Every watch opened for a role without a script delivers `steps`.
    pub(crate) fn default_script(&self, steps: Vec<Step>) {
        *self.default.lock().unwrap() = steps;
    }

    /// Every watch of `role` is refused with `error`.
    pub(crate) fn refuse(&self, role: &str, error: LeaseError) {
        self.refusals.lock().unwrap().insert(role.to_owned(), error);
    }

    /// The next yield of `role` is answered with `answer`.
    pub(crate) fn answer_yield(&self, role: &str, answer: Result<bool, LeaseError>) {
        self.shared
            .lock()
            .unwrap()
            .yields
            .entry(role.to_owned())
            .or_default()
            .push_back(answer);
    }

    /// Deliver `step` to the open watch of `role`. `false` when none is
    /// open.
    pub(crate) fn send(&self, role: &str, step: Step) -> bool {
        self.shared
            .lock()
            .unwrap()
            .live
            .get(role)
            .is_some_and(|live| live.send(step).is_ok())
    }

    pub(crate) fn log(&self) -> Log {
        self.shared.lock().unwrap().log.clone()
    }
}

#[async_trait]
impl RoleLeases for SampleLeases {
    async fn watch(&self, role: &str) -> Result<Watch, LeaseError> {
        self.shared.lock().unwrap().log.opened.push(role.to_owned());
        if let Some(error) = self.refusals.lock().unwrap().get(role) {
            return Err(error.clone());
        }
        let mut steps = self
            .scripts
            .lock()
            .unwrap()
            .get(role)
            .cloned()
            .unwrap_or_else(|| self.default.lock().unwrap().clone());
        if let Some(clock) = &self.rebase {
            let first = steps.iter().find_map(|step| match step {
                Step::Notice(notice) => Some(notice.issued_at_ms),
                _ => None,
            });
            if let Some(first) = first {
                let now = clock();
                for step in &mut steps {
                    if let Step::Notice(notice) = step {
                        notice.issued_at_ms = now + (notice.issued_at_ms - first);
                    }
                }
            }
        }
        let (live, delivered) = mpsc::unbounded_channel();
        for step in steps {
            live.send(step).expect("the watch is open");
        }
        self.shared
            .lock()
            .unwrap()
            .live
            .insert(role.to_owned(), live);
        Ok(Watch {
            notices: Box::new(SampleNotices {
                role: role.to_owned(),
                delivered,
                ended: false,
                shared: Arc::clone(&self.shared),
            }),
            route: Arc::new(SampleRoute {
                role: role.to_owned(),
                shared: Arc::clone(&self.shared),
            }),
        })
    }
}

struct SampleNotices {
    role: String,
    delivered: mpsc::UnboundedReceiver<Step>,
    ended: bool,
    shared: Arc<Mutex<Shared>>,
}

#[async_trait]
impl Notices for SampleNotices {
    async fn next(&mut self) -> Option<Result<Notice, LeaseError>> {
        if self.ended {
            return None;
        }
        match self.delivered.recv().await {
            Some(Step::Notice(notice)) => Some(Ok(notice)),
            Some(Step::Refuse(error)) => {
                self.ended = true;
                Some(Err(error))
            }
            Some(Step::End) | None => {
                self.ended = true;
                None
            }
        }
    }
}

impl Drop for SampleNotices {
    fn drop(&mut self) {
        let mut shared = self.shared.lock().unwrap();
        shared.live.remove(&self.role);
        shared.log.closed.push(self.role.clone());
    }
}

struct SampleRoute {
    role: String,
    shared: Arc<Mutex<Shared>>,
}

#[async_trait]
impl LeaseRoute for SampleRoute {
    async fn ack(&self, seq: u64) -> Result<(), LeaseError> {
        self.shared
            .lock()
            .unwrap()
            .log
            .acks
            .push((self.role.clone(), seq));
        Ok(())
    }

    async fn yield_role(&self, gen: u64) -> Result<bool, LeaseError> {
        let answer = {
            let mut shared = self.shared.lock().unwrap();
            shared.log.yields.push((self.role.clone(), gen));
            shared
                .yields
                .get_mut(&self.role)
                .and_then(VecDeque::pop_front)
        };
        match answer {
            Some(answer) => answer,
            // A yield whose answer is lost.
            None => std::future::pending().await,
        }
    }
}
