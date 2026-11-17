//! Where a slow `ctx_search` or `ctx_memory` call spent its time.
//!
//! A call is stamped as it reaches each step on its way: the transport
//! receiving it, the session's worker taking it off its queue, the session
//! being resumed or restored, and each step of the tool itself, down to each
//! source a search reads. A stamp is one `Instant::now()`; nothing is
//! measured, counted or written while the call runs. Only a call that took
//! [`SLOW`] or longer from its arrival writes its stamps out, as one line
//! after its answer has left ([`ToolTiming::log`]). The line lists each step
//! with the milliseconds since the stamp before it, so the steps add up to
//! the call's time, and the jobs the session's worker ran while the call
//! waited in its queue.
//!
//! The line never carries the query or any other text of the call: only
//! the query's length, the sources asked for, the memory action and the
//! number of results.

use std::fmt::Write as _;
use std::time::{Duration, Instant};

use cortexkit_role_compaction::read::SessionRef;
use serde_json::Value;

/// A call that took this long or longer is logged with its steps. It is
/// the threshold of the transport's slow-answer line, which this line
/// explains.
pub const SLOW: Duration = Duration::from_millis(500);
/// From this the line is a warning, as the slow-answer line is: runners
/// give ck-mc's per-step hook 1,500 ms before they go on without it.
const WARN: Duration = Duration::from_millis(1_500);

/// How many stamps a call keeps; later ones are dropped. A search takes
/// about twenty.
const CALL_MARKS: usize = 48;
/// How many stamps one store read keeps ([`Stamps`]).
const READ_MARKS: usize = 16;
/// How many of the latest jobs a session's worker remembers
/// ([`WorkerJobs`]).
const WORKER_JOBS: usize = 16;

/// One stamp: the step that ended at `at`, and a word on how it ended when
/// that matters (an embedding that timed out, a search that had to scan the
/// whole store).
#[derive(Clone, Copy, Debug)]
struct Mark {
    step: &'static str,
    detail: &'static str,
    at: Instant,
}

/// Stamps taken where a call's [`ToolTiming`] can't go: a store read that
/// runs on Tokio's blocking pool. The read hands them back with its result
/// and the caller appends them ([`ToolTiming::append`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct Stamps {
    marks: [Option<Mark>; READ_MARKS],
    len: usize,
}

impl Stamps {
    /// Stamp the end of `step`.
    pub fn mark(&mut self, step: &'static str) {
        self.mark_detail(step, "");
    }

    /// Stamp the end of `step`, with a word on how it ended.
    pub fn mark_detail(&mut self, step: &'static str, detail: &'static str) {
        if let Some(slot) = self.marks.get_mut(self.len) {
            *slot = Some(Mark {
                step,
                detail,
                at: Instant::now(),
            });
            self.len += 1;
        }
    }
}

/// The stamps of one `ctx_*` tool call, from the moment the transport
/// received it ([`ToolTiming::new`]).
#[derive(Clone, Debug)]
pub struct ToolTiming {
    arrived: Instant,
    marks: [Option<Mark>; CALL_MARKS],
    len: usize,
    /// How many results a search answered with.
    results: Option<usize>,
}

impl ToolTiming {
    /// A call that arrived at `arrived`.
    pub fn new(arrived: Instant) -> Self {
        Self {
            arrived,
            marks: [None; CALL_MARKS],
            len: 0,
            results: None,
        }
    }

    /// Stamp the end of `step`.
    pub fn mark(&mut self, step: &'static str) {
        self.mark_detail(step, "");
    }

    /// Stamp the end of `step`, with a word on how it ended.
    pub fn mark_detail(&mut self, step: &'static str, detail: &'static str) {
        self.push(Mark {
            step,
            detail,
            at: Instant::now(),
        });
    }

    /// Stamp the end of `step` at a moment the caller already read.
    pub(crate) fn mark_at(&mut self, step: &'static str, at: Instant) {
        self.push(Mark {
            step,
            detail: "",
            at,
        });
    }

    /// Add the stamps a store read took on another thread, after this
    /// call's own: the read ran after the call's latest stamp and before its
    /// next one.
    pub fn append(&mut self, stamps: &Stamps) {
        for mark in stamps.marks.iter().take(stamps.len).flatten() {
            self.push(*mark);
        }
    }

    /// The number of results a search answered with.
    pub fn results(&mut self, count: usize) {
        self.results = Some(count);
    }

    fn push(&mut self, mark: Mark) {
        if let Some(slot) = self.marks.get_mut(self.len) {
            *slot = Some(mark);
            self.len += 1;
        }
    }

    fn marks(&self) -> impl Iterator<Item = &Mark> {
        self.marks.iter().take(self.len).flatten()
    }

    /// When the call was queued for the session's worker and when the
    /// worker took it: the first `route` and `queue` stamps.
    fn queue_window(&self) -> Option<(Instant, Instant)> {
        let sent = self.marks().find(|mark| mark.step == "route")?.at;
        let taken = self.marks().find(|mark| mark.step == "queue")?.at;
        Some((sent, taken))
    }

    /// Each step with the whole milliseconds since the stamp before it, and
    /// `rest`, the time from the last stamp to `elapsed`.
    fn steps(&self, elapsed: Duration) -> String {
        let mut line = String::new();
        let mut previous = self.arrived;
        for mark in self.marks() {
            let spent = mark.at.saturating_duration_since(previous).as_millis();
            let _ = write!(line, "{}={spent}", mark.step);
            if !mark.detail.is_empty() {
                let _ = write!(line, "({})", mark.detail);
            }
            line.push(' ');
            previous = mark.at;
        }
        let rest = elapsed.saturating_sub(previous.saturating_duration_since(self.arrived));
        let _ = write!(line, "rest={}", rest.as_millis());
        line
    }

    /// Log the call's steps when it took [`SLOW`] or longer since it
    /// arrived; otherwise do nothing. `op` is the tool's name, `input` its
    /// arguments, of which only the query's length, the sources and the
    /// memory action are logged. `jobs` is the session worker's record of the
    /// jobs it ran, which names what ran while the call waited.
    pub(crate) fn log(&self, op: &str, session: &SessionRef, input: &Value, jobs: &WorkerJobs) {
        let elapsed = self.arrived.elapsed();
        if elapsed < SLOW {
            return;
        }
        let elapsed_ms = elapsed.as_millis();
        let steps = self.steps(elapsed);
        let ahead = self
            .queue_window()
            .map(|(sent, taken)| jobs.during(sent, taken))
            .unwrap_or_default();
        let call = describe(op, input, self.results);
        let (session, caller) = (session.session.as_str(), session.runner.as_str());
        let (call, steps, ahead) = (call.as_str(), steps.as_str(), ahead.as_str());
        if elapsed >= WARN {
            tracing::warn!(
                op,
                elapsed_ms,
                session,
                caller,
                call,
                steps,
                ahead,
                "ck-mc slow tool steps"
            );
        } else {
            tracing::info!(
                op,
                elapsed_ms,
                session,
                caller,
                call,
                steps,
                ahead,
                "ck-mc slow tool steps"
            );
        }
    }
}

/// What the call asked for, without any of its text: a search's query
/// length in characters, its sources and its result count; a memory call's
/// action.
fn describe(op: &str, input: &Value, results: Option<usize>) -> String {
    match op {
        "ctx_search" => {
            let query_chars = input
                .get("query")
                .and_then(Value::as_str)
                .map_or(0, |query| query.trim().chars().count());
            let sources = match input.get("sources").and_then(Value::as_array) {
                Some(list) if !list.is_empty() => list
                    .iter()
                    .map(|source| known(source.as_str(), &crate::search::SOURCES))
                    .collect::<Vec<_>>()
                    .join(","),
                _ => "all".to_owned(),
            };
            let mut line = format!("query_chars={query_chars} sources={sources}");
            if let Some(results) = results {
                let _ = write!(line, " results={results}");
            }
            line
        }
        "ctx_memory" => {
            let action = input.get("action").and_then(Value::as_str);
            format!(
                "action={}",
                known(action, &["write", "get", "update", "archive", "merge"])
            )
        }
        _ => String::new(),
    }
}

/// `value` when it is one of `names`, which are fixed words, else `other`:
/// a model may put anything in a field, and only fixed words are logged.
fn known(value: Option<&str>, names: &[&'static str]) -> &'static str {
    value
        .and_then(|value| names.iter().find(|name| **name == value).copied())
        .unwrap_or("other")
}

/// The latest jobs a session's worker started, each with its kind and the
/// moment it started. A job runs until the next one starts, as the worker
/// runs one job at a time and a job's follow-up work (publishing, saving)
/// belongs to it.
#[derive(Debug)]
pub(crate) struct WorkerJobs {
    starts: [Option<(&'static str, Instant)>; WORKER_JOBS],
    next: usize,
}

impl Default for WorkerJobs {
    fn default() -> Self {
        Self {
            starts: [None; WORKER_JOBS],
            next: 0,
        }
    }
}

impl WorkerJobs {
    /// A job of `kind` started at `at`.
    pub(crate) fn started(&mut self, kind: &'static str, at: Instant) {
        self.starts[self.next % WORKER_JOBS] = Some((kind, at));
        self.next += 1;
    }

    /// The jobs that ran between `from` and `to`, oldest first, each as
    /// `kind:milliseconds` of that window it took. When jobs from the
    /// window's start are no longer remembered, the list says so.
    fn during(&self, from: Instant, to: Instant) -> String {
        let ordered: Vec<(&'static str, Instant)> = (0..WORKER_JOBS)
            .filter_map(|offset| self.starts[(self.next + offset) % WORKER_JOBS])
            .collect();
        let mut line = Vec::new();
        if self.next > WORKER_JOBS && ordered.first().is_some_and(|(_, start)| *start > from) {
            line.push("older jobs not kept".to_owned());
        }
        for (index, (kind, start)) in ordered.iter().enumerate() {
            let end = ordered.get(index + 1).map_or(to, |(_, next)| *next).min(to);
            if end <= from || *start >= to {
                continue;
            }
            let spent = end.saturating_duration_since((*start).max(from));
            line.push(format!("{kind}:{}", spent.as_millis()));
        }
        line.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_add_up_to_the_elapsed_time() {
        let arrived = Instant::now();
        let mut timing = ToolTiming::new(arrived);
        timing.mark_at("route", arrived + Duration::from_millis(2));
        timing.mark_at("queue", arrived + Duration::from_millis(700));
        let mut stamps = Stamps::default();
        stamps.marks[0] = Some(Mark {
            step: "embed",
            detail: "timeout",
            at: arrived + Duration::from_millis(900),
        });
        stamps.len = 1;
        timing.append(&stamps);
        assert_eq!(
            timing.steps(Duration::from_millis(1_000)),
            "route=2 queue=698 embed=200(timeout) rest=100"
        );
    }

    #[test]
    fn jobs_during_a_wait_are_named_with_the_time_they_took_of_it() {
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let mut jobs = WorkerJobs::default();
        jobs.started("setup", at(0));
        jobs.started("notice", at(100));
        jobs.started("ride", at(900));
        jobs.started("tool:ctx_memory", at(950));
        // Queued at 300, taken at 950: the notice from 300, then the ride.
        assert_eq!(jobs.during(at(300), at(950)), "notice:600 ride:50");
        for ms in 1..=WORKER_JOBS as u64 {
            jobs.started("idle", at(1_000 + ms));
        }
        assert!(jobs
            .during(at(300), at(2_000))
            .starts_with("older jobs not kept"));
    }

    #[test]
    fn a_call_is_described_without_its_text() {
        let search = serde_json::json!({
            "query": " where is the lock taken ",
            "sources": ["memory", "secret words"],
        });
        assert_eq!(
            describe("ctx_search", &search, Some(3)),
            "query_chars=23 sources=memory,other results=3"
        );
        let memory = serde_json::json!({"action": "get", "ids": [1]});
        assert_eq!(describe("ctx_memory", &memory, None), "action=get");
        let odd = serde_json::json!({"action": "tell me everything"});
        assert_eq!(describe("ctx_memory", &odd, None), "action=other");
    }
}
