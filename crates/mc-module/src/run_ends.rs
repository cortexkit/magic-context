//! Waking the waits on ck-mc's own child runs when their runner says a run
//! ended.
//!
//! A summary or dreamer run happens in a child session on a runner, and
//! ck-mc follows it by reading the run's result until the run ends
//! ([`crate::summary::run`]). Both runners publish an event when a run ends:
//! Broca `event.broca.run.ended.v1`, THALAMUS's Agent Runner
//! `event.thalamus-harness.turn_ended.v1`. ck-mc reads both from its durable
//! [`DURABLE`] ([`crate::bus`]). An event names the session in its
//! `session_ref` header: the llm-runner `session_ref`, a hash of the runner,
//! harness and session id ([`cortexkit_role_llm_runner::session_ref`]). The
//! event carries no body on the bus, and ck-mc needs none. A wait registers
//! its child's ref before it sends ([`RunEnds::watch`]); an event with that
//! ref wakes it, and it makes one read and goes by what that read says. The
//! event itself decides nothing. An event for a session nobody waits on, or
//! any other event that reaches the reader, is acknowledged and dropped.
//!
//! Reading on a timer stays as the backstop. While the reader is connected
//! and has read from the durable since it connected, a wait reads every
//! [`BACKSTOP_POLL`]; otherwise every [`FAST_POLL`], as it did before these
//! events existed. Each change between the two is logged once.
//!
//! The reader binds the durable with async-nats on ck-mc's one bus
//! connection; it moves onto the event reader of SUBC's shared bus client
//! when ck-mc moves to that client.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use cortexkit_bus_trait::Headers;
use cortexkit_role_compaction::read::SessionRef;
use tokio::sync::Notify;

/// The durable on the account's EVENT stream that carries the run-end
/// events of every runner ck-mc runs children on.
pub const DURABLE: &str = "m_magic-context_runs";
/// The events [`DURABLE`] carries, relative to `ck.{account}.`.
pub const SUBJECTS: [&str; 2] = [
    "event.thalamus-harness.turn_ended.v1",
    "event.broca.run.ended.v1",
];
/// The header that names an event's session by its `session_ref`.
pub const SESSION_REF_HEADER: &str = "session_ref";
/// How often a wait reads its run while no reader delivers run-end events.
pub const FAST_POLL: Duration = Duration::from_millis(500);
/// How often a wait reads its run while the reader delivers them: only a
/// backstop for an event that never comes.
pub const BACKSTOP_POLL: Duration = Duration::from_secs(15);
/// How long the reader waits before binding the durable again after it
/// stopped reading.
pub const RETRY: Duration = Duration::from_secs(60);
/// How many handled event ids are remembered. The durable redelivers an event
/// whose acknowledgement was lost one ack wait (30 s) later, so only recent
/// ids can come again.
const REMEMBERED: usize = 4096;

/// The waits on child runs in this process, and whether a reader is
/// delivering their runners' run-end events.
#[derive(Default)]
pub struct RunEnds {
    /// Each wait's wake, by its child's `session_ref`.
    waits: Mutex<HashMap<String, Vec<Waiting>>>,
    next_wait: AtomicU64,
    reader: Mutex<Reader>,
    handled: Mutex<Handled>,
    /// Whether an event without a `session_ref` header was logged, so it
    /// is logged once.
    unnamed_logged: AtomicBool,
}

/// One registered wait: its id, and what wakes it.
type Waiting = (u64, Arc<Notify>);

/// Where the reader is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Reader {
    /// It has not read yet, nor failed.
    #[default]
    Unstarted,
    /// It is connected and has read from the durable since it connected.
    Reading,
    /// It is not connected, or the durable could not be read.
    Stopped,
}

/// The ids of recently handled events, oldest first.
#[derive(Default)]
struct Handled {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl Handled {
    /// Remember `id`; false when it was handled already.
    fn insert(&mut self, id: &str) -> bool {
        if self.ids.contains(id) {
            return false;
        }
        if self.order.len() == REMEMBERED {
            if let Some(oldest) = self.order.pop_front() {
                self.ids.remove(&oldest);
            }
        }
        self.order.push_back(id.to_owned());
        self.ids.insert(id.to_owned());
        true
    }
}

/// What handling one event did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Woke {
    /// It woke this many waits.
    Waits(usize),
    /// No wait is registered for its session.
    Nobody,
    /// The same event was handled before; it woke nothing this time.
    Again,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl RunEnds {
    pub fn new() -> Self {
        Self::default()
    }

    /// How long a wait sleeps between two reads of its run.
    pub fn poll_interval(&self) -> Duration {
        match *lock(&self.reader) {
            Reader::Reading => BACKSTOP_POLL,
            Reader::Unstarted | Reader::Stopped => FAST_POLL,
        }
    }

    /// Register a wait on a run in `child`, the child session's identity as
    /// the runner knows it, until the returned watch is dropped. A wait
    /// registers before it sends, so an event that arrives while it reads is
    /// kept for its next pause.
    pub(crate) fn watch(&self, child: &SessionRef) -> Watch<'_> {
        let session_ref = crate::agent_data::source::session_ref(child);
        let id = self.next_wait.fetch_add(1, Ordering::Relaxed);
        let notify = Arc::new(Notify::new());
        lock(&self.waits)
            .entry(session_ref.clone())
            .or_default()
            .push((id, notify.clone()));
        Watch {
            ends: self,
            session_ref,
            id,
            notify,
        }
    }

    /// Wake every wait registered for `session_ref`. An event handled before
    /// under the same `event_id` wakes nobody: the durable redelivers events,
    /// and one end of a run is one read.
    pub(crate) fn wake(&self, event_id: Option<&str>, session_ref: &str) -> Woke {
        if let Some(id) = event_id {
            if !lock(&self.handled).insert(id) {
                return Woke::Again;
            }
        }
        match lock(&self.waits).get(session_ref) {
            Some(waits) => {
                for (_, notify) in waits {
                    notify.notify_one();
                }
                Woke::Waits(waits.len())
            }
            None => Woke::Nobody,
        }
    }

    /// The reader read from the durable: waits relax to the backstop poll.
    pub(crate) fn reading(&self) {
        let mut reader = lock(&self.reader);
        if *reader != Reader::Reading {
            *reader = Reader::Reading;
            tracing::info!(
                "ck-mc: run ends: reading {DURABLE}; summary and dreamer runs are read every 15 s as a backstop"
            );
        }
    }

    /// The reader stopped, or could not start, for `reason`: waits read
    /// every [`FAST_POLL`] again.
    pub(crate) fn stopped(&self, reason: &str) {
        let mut reader = lock(&self.reader);
        let was = *reader;
        if was == Reader::Stopped {
            return;
        }
        *reader = Reader::Stopped;
        drop(reader);
        tracing::info!(
            "ck-mc: run ends: not reading {DURABLE} ({reason}); summary and dreamer runs are read every 500 ms"
        );
        if was == Reader::Reading {
            // A wait asleep for the backstop interval would sleep it out:
            // wake each one, so it reads now and sleeps the short interval
            // after.
            for waits in lock(&self.waits).values() {
                for (_, notify) in waits {
                    notify.notify_one();
                }
            }
        }
    }
}

/// One wait's registration for its child's run-end events, until dropped.
pub(crate) struct Watch<'a> {
    ends: &'a RunEnds,
    session_ref: String,
    id: u64,
    notify: Arc<Notify>,
}

impl Watch<'_> {
    /// Sleep until the next read of the run is due: one poll interval from
    /// now, at most until `deadline`, or sooner when an event says the run
    /// ended. A wake that came while the wait was reading ends this pause at
    /// once.
    pub(crate) async fn pause(&self, deadline: tokio::time::Instant) {
        let due = (tokio::time::Instant::now() + self.ends.poll_interval()).min(deadline);
        let _ = tokio::time::timeout_at(due, self.notify.notified()).await;
    }
}

impl Drop for Watch<'_> {
    fn drop(&mut self) {
        let mut waits = lock(&self.ends.waits);
        if let Some(list) = waits.get_mut(&self.session_ref) {
            list.retain(|(id, _)| *id != self.id);
            if list.is_empty() {
                waits.remove(&self.session_ref);
            }
        }
    }
}

/// Sleep until the next read of a child run is due: through `watch` when
/// the wait has one, otherwise every [`FAST_POLL`], at most until `deadline`.
pub(crate) async fn pause(watch: Option<&Watch<'_>>, deadline: tokio::time::Instant) {
    match watch {
        Some(watch) => watch.pause(deadline).await,
        None => {
            tokio::time::sleep_until((tokio::time::Instant::now() + FAST_POLL).min(deadline)).await
        }
    }
}

/// The session a run-end event names in its `session_ref` header, or `None`
/// when it names none. Only headers are read: the event carries no body on
/// the bus, and a payload that happens to come with it is never parsed.
pub(crate) fn session_ref_of(headers: &Headers) -> Option<&str> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(SESSION_REF_HEADER))
        .map(|(_, value)| value.as_str())
        .filter(|session_ref| !session_ref.is_empty())
}

/// One event read from the durable and not yet acknowledged.
#[derive(Clone, Debug)]
pub(crate) struct Delivery {
    /// The bus's id for the event, which a redelivery repeats; `None` when the
    /// backend can name none.
    pub id: Option<String>,
    pub subject: String,
    /// The message's headers, by name, each with its last value.
    pub headers: Headers,
}

/// The durable, bound. At most one event is out at a time: the reader
/// acknowledges each before it reads the next.
#[async_trait]
#[allow(clippy::double_must_use)]
pub(crate) trait Cursor: Send {
    /// The next event, or `None` when none came within one pull.
    async fn next(&mut self) -> Result<Option<Delivery>, String>;
    /// Acknowledge the event `next` returned last.
    async fn ack(&mut self) -> Result<(), String>;
}

/// Where the reader binds the durable: the bus, or a test's events.
#[async_trait]
#[allow(clippy::double_must_use)]
pub(crate) trait Durable: Send + Sync {
    async fn bind(&self) -> Result<Box<dyn Cursor>, String>;
}

/// Read the durable for as long as the process runs: bind it, wake the waits
/// its events name, and bind it again [`RETRY`] after it stopped.
pub(crate) async fn read(ends: Arc<RunEnds>, durable: Arc<dyn Durable>) {
    loop {
        let reason = read_bound(&ends, durable.as_ref()).await;
        ends.stopped(&reason);
        tokio::time::sleep(RETRY).await;
    }
}

/// Bind the durable once and read it until something fails; why it stopped.
pub(crate) async fn read_bound(ends: &RunEnds, durable: &dyn Durable) -> String {
    let mut cursor = match durable.bind().await {
        Ok(cursor) => cursor,
        Err(reason) => return reason,
    };
    loop {
        let delivery = match cursor.next().await {
            Ok(delivery) => delivery,
            Err(reason) => return reason,
        };
        ends.reading();
        let Some(delivery) = delivery else {
            continue;
        };
        handle(ends, &delivery);
        // Acknowledged only now that its wait was woken, or found missing.
        if let Err(reason) = cursor.ack().await {
            return reason;
        }
    }
}

/// What the reader did with one event.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// A run-end event: what waking its session's waits did.
    Ended(Woke),
    /// Another event of a runner's, which the durable's filters should keep
    /// out: it wakes nobody.
    NotARunEnd,
    /// A run-end event without a `session_ref` header.
    NoSession,
}

/// Whether `subject` is one of [`SUBJECTS`] in some account:
/// `ck.{account}.` followed by it.
fn is_run_end(subject: &str) -> bool {
    subject
        .strip_prefix("ck.")
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(_, event)| SUBJECTS.contains(&event))
}

/// Wake the waits on the session `delivery` names. Any other event of a
/// runner's, such as Broca's `run.started`, wakes nobody, since only a run's
/// end is worth a read. A run-end event without a `session_ref` header is
/// logged the first time one comes. Either way the reader acknowledges the
/// event, so one bad event never stops it.
fn handle(ends: &RunEnds, delivery: &Delivery) -> Outcome {
    if !is_run_end(&delivery.subject) {
        return Outcome::NotARunEnd;
    }
    let Some(session_ref) = session_ref_of(&delivery.headers) else {
        if !ends.unnamed_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "ck-mc: run ends: an event on {} has no session_ref header; acknowledged without waking anyone, and later ones are not logged",
                delivery.subject
            );
        }
        return Outcome::NoSession;
    };
    let woke = ends.wake(delivery.id.as_deref(), session_ref);
    // One line per run end that a wait was blocked on, so the log shows that
    // events, not the backstop poll, end ck-mc's waits.
    if let Woke::Waits(waits) = woke {
        let event = delivery
            .subject
            .rsplit_once(".event.")
            .map_or(delivery.subject.as_str(), |(_, event)| event);
        tracing::info!(
            "ck-mc: run ends: {event} for session ref {session_ref} woke {waits} wait(s)"
        );
    }
    Outcome::Ended(woke)
}

#[cfg(test)]
#[path = "run_ends_tests.rs"]
pub(crate) mod tests;
