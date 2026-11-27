//! Historian telemetry keeps only routing identifiers, fixed labels and counts.
//! Publication and the optional second turn carry the same record. Dropping
//! its final reference queues the batch without waiting for SQLite.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use cortexkit_role_compaction::read::SessionRef;
use cortexkit_role_compaction::setup::ModelRef;
use cortexkit_role_llm_runner::usage::RunUsage;
use rusqlite::{params, Connection};
use serde_json::json;

use super::run::{now_ms, ObservedSend, SummaryError};
use super::validate::{ValidatedChunk, HISTORIAN_CATEGORIES};
use crate::search::background::HistorianWriter;

#[derive(Clone, Debug)]
pub(crate) struct Record(Arc<Mutex<Pending>>);

#[derive(Debug)]
struct Pending {
    writer: HistorianWriter,
    started: Instant,
    run: Option<Box<Finished>>,
}

#[derive(Debug)]
pub(crate) struct Finished {
    owner: SessionRef,
    trigger: Option<&'static str>,
    ended_at: i64,
    duration_ms: u64,
    chunk: Option<Chunk>,
    reply: Reply,
    output: Option<Stored>,
    requests: Vec<Invocation>,
    not_sent: usize,
    unconfirmed: usize,
    status: &'static str,
    reason: Option<&'static str>,
}

#[derive(Debug)]
struct Chunk {
    first: u64,
    last: u64,
    chars: usize,
    messages: usize,
}

#[derive(Debug, Default)]
struct Reply {
    next: Option<u64>,
    facts: BTreeMap<&'static str, usize>,
    events: usize,
    discarded_last: bool,
}

#[derive(Debug)]
struct Stored {
    count: usize,
    first_id: Option<i64>,
    last_id: Option<i64>,
    events: usize,
    promoted: usize,
    importance_min: Option<u64>,
    importance_max: Option<u64>,
    importance_avg: Option<f64>,
    tier_chars: [usize; 4],
    legacy: bool,
    publication_id: Option<String>,
}

#[derive(Debug)]
struct Invocation {
    pass: Pass,
    provider: String,
    model: String,
    started_at: i64,
    ended_at: i64,
    error: Option<&'static str>,
    usage: Option<RunUsage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pass {
    One,
    Two,
    FactCheck,
}

impl Pass {
    fn task(self) -> &'static str {
        match self {
            Self::One => "turn_one",
            Self::Two => "turn_two",
            Self::FactCheck => "fact_check",
        }
    }
}

impl Record {
    pub(crate) fn start(
        writer: HistorianWriter,
        owner: SessionRef,
        trigger: Option<&'static str>,
    ) -> Self {
        Self(Arc::new(Mutex::new(Pending {
            writer,
            started: Instant::now(),
            run: Some(Box::new(Finished {
                owner,
                trigger,
                ended_at: 0,
                duration_ms: 0,
                chunk: None,
                reply: Reply::default(),
                output: None,
                requests: Vec::new(),
                not_sent: 0,
                unconfirmed: 0,
                status: "failed",
                reason: Some("publication_abandoned"),
            })),
        })))
    }

    fn update(&self, apply: impl FnOnce(&mut Finished)) {
        let mut pending = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(run) = &mut pending.run {
            apply(run);
        }
    }

    pub(crate) fn chunk(&self, first: u64, last: u64, messages: usize, rendered: &str) {
        let chars = chars(rendered);
        self.update(|run| {
            run.chunk = Some(Chunk {
                first,
                last,
                chars,
                messages,
            })
        });
    }

    pub(crate) fn observed(
        &self,
        pass: Pass,
        model: &ModelRef,
        observed: ObservedSend,
        spent: bool,
        error: Option<&'static str>,
    ) {
        self.update(|run| {
            run.not_sent += observed.not_sent;
            let Some(started_at) = observed.sent_at else {
                return;
            };
            if spent || (observed.finished && !observed.never_delivered) {
                run.requests.push(Invocation {
                    pass,
                    provider: model.provider.clone(),
                    model: model.model.clone(),
                    started_at,
                    ended_at: now_ms().max(started_at),
                    error: error.map(|error| observed.error_class.unwrap_or(error)),
                    usage: observed.usage,
                });
            } else if observed.never_delivered {
                run.not_sent += 1;
            } else {
                run.unconfirmed += 1;
            }
        });
    }

    pub(crate) fn invalid_reply(&self) {
        self.update(|run| {
            if let Some(request) = run.requests.last_mut() {
                request.error = Some("invalid_turn_one_reply");
            }
        });
    }

    pub(crate) fn ended_early(&self, error: Option<&SummaryError>) {
        self.update(|run| {
            (run.status, run.reason) = match error {
                None => ("noop", None),
                Some(SummaryError::AccountWait(_) | SummaryError::NeverRan(_))
                    if run.requests.is_empty() =>
                {
                    ("noop", error.map(summary_error_class))
                }
                Some(_) if run.unconfirmed != 0 => ("failed", Some("unconfirmed")),
                Some(error) => (
                    "failed",
                    Some(
                        if matches!(
                            error,
                            SummaryError::Failed(_) | SummaryError::PaidThenWait { .. }
                        ) {
                            run.requests
                                .last()
                                .and_then(|request| request.error)
                                .unwrap_or_else(|| summary_error_class(error))
                        } else {
                            summary_error_class(error)
                        },
                    ),
                ),
            };
        });
    }

    pub(crate) fn reply(&self, validated: &ValidatedChunk) {
        self.update(|run| {
            run.reply = Reply {
                next: Some(validated.unprocessed_from),
                events: validated.events.len(),
                discarded_last: validated.discarded_last,
                ..Reply::default()
            };
            for fact in &validated.facts {
                // Only fixed category keys can reach SQLite, even if the parser
                // someday accepts arbitrary category tags.
                let category = HISTORIAN_CATEGORIES
                    .iter()
                    .copied()
                    .find(|&name| name == fact.category)
                    .unwrap_or("UNKNOWN");
                *run.reply.facts.entry(category).or_default() += 1;
            }
        });
    }

    pub(crate) fn stale(&self) {
        self.update(|run| run.reason = Some("transcript_changed"));
    }

    pub(crate) fn published(
        &self,
        validated: &ValidatedChunk,
        ids: &[i64],
        events: usize,
        publication_id: Option<&str>,
    ) {
        let mut tier_chars = [0; 4];
        let mut legacy = false;
        for c in &validated.compartments {
            legacy |= c.p1.as_deref().is_none_or(str::is_empty);
            for (total, tier) in tier_chars.iter_mut().zip([&c.p1, &c.p2, &c.p3, &c.p4]) {
                *total += tier.as_deref().map_or(0, chars);
            }
        }
        let scores = || {
            validated
                .compartments
                .iter()
                .map(|c| c.importance.unwrap_or(50))
        };
        self.update(|run| {
            run.status = "success";
            run.reason = None;
            run.output = Some(Stored {
                count: ids.len(),
                first_id: ids.iter().min().copied(),
                last_id: ids.iter().max().copied(),
                events,
                promoted: 0,
                importance_min: scores().min(),
                importance_max: scores().max(),
                importance_avg: (!ids.is_empty())
                    .then(|| scores().sum::<u64>() as f64 / ids.len() as f64),
                tier_chars,
                legacy,
                publication_id: publication_id.map(str::to_owned),
            });
        });
    }

    pub(crate) fn promoted(&self, publication_id: &str) {
        self.update(|run| {
            if let Some(output) = &mut run.output {
                if output.publication_id.as_deref() == Some(publication_id) {
                    output.promoted += 1;
                }
            }
        });
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(mut run) = self.run.take() {
            run.ended_at = now_ms();
            run.duration_ms = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            self.writer.record(run);
        }
    }
}

/// Match the plugin's JavaScript string lengths, including supplementary characters.
fn chars(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(crate) fn summary_error_class(error: &SummaryError) -> &'static str {
    match error {
        SummaryError::AccountWait(_) => "account_wait",
        SummaryError::NeverRan(_) => "never_ran",
        SummaryError::Uncertain(_) => "unconfirmed",
        SummaryError::Failed(message) | SummaryError::PaidThenWait { error: message, .. } => {
            if message.starts_with("prompt_over_window:") {
                "prompt_over_window"
            } else if message.starts_with("the run did not finish in time") {
                "timeout"
            } else if message.starts_with("invalid turn-one reply:") {
                "invalid_turn_one_reply"
            } else if message.starts_with("the reply hit its output limit") {
                "output_limit"
            } else {
                "provider_error"
            }
        }
    }
}

fn integer(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

impl Finished {
    pub(crate) fn insert(&self, conn: &mut Connection) -> rusqlite::Result<()> {
        // One short transaction prevents partially linked telemetry if an insert fails.
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut turn_one = None;
        for request in &self.requests {
            let usage = request.usage.as_ref();
            let count = |value: Option<u64>| integer(value.unwrap_or_default());
            tx.execute(
                "INSERT INTO subagent_invocations (session_id, harness, subagent, task, provider_id, model_id,
                    started_at, ended_at, status, input_tokens, output_tokens, cache_read_tokens,
                    cache_write_tokens, error, parent_invocation_id)
                 VALUES (?1, ?2, 'historian', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![self.owner.session, self.owner.harness, request.pass.task(), request.provider,
                    request.model, request.started_at, request.ended_at,
                    if request.error.is_none() { "completed" } else { "failed" },
                    count(usage.and_then(|u| u.input_tokens)), count(usage.and_then(|u| u.output_tokens)),
                    count(usage.and_then(|u| u.cached_input_tokens)), count(usage.and_then(|u| u.cache_write_tokens)),
                    request.error, (request.pass != Pass::One).then_some(turn_one).flatten()],
            )?;
            if request.pass == Pass::One {
                turn_one = Some(tx.last_insert_rowid());
            }
        }
        let chunk = self.chunk.as_ref();
        let output = self.output.as_ref();
        let mut counters = serde_json::to_value(&self.reply.facts).expect("numeric fact counts");
        counters["facts_promoted"] = json!(output.map_or(0, |o| o.promoted));
        counters["events_published"] = json!(output.map_or(0, |o| o.events));
        counters["chunk_chars"] = json!(chunk.map_or(0, |c| c.chars));
        counters["chunk_messages"] = json!(chunk.map_or(0, |c| c.messages));
        counters["tier_chars"] = json!(output.map_or([0; 4], |o| o.tier_chars));
        counters["duration_ms"] = json!(self.duration_ms);
        counters["requests"] = json!(self.requests.len());
        if let Some(trigger) = self.trigger {
            counters["trigger"] = json!(trigger);
        }
        if self.not_sent != 0 {
            counters["not_sent"] = json!(self.not_sent);
        }
        if self.unconfirmed != 0 {
            counters["unconfirmed"] = json!(self.unconfirmed);
        }
        // Match the TypeScript historian's 512-character cap. These labels
        // are fixed ASCII classes, not runner or provider error text.
        let reason = self.reason.map(|text| &text[..text.len().min(512)]);
        tx.execute(
            "INSERT INTO historian_runs (session_id, harness, subagent_invocation_id, run_kind, status,
                failure_reason, chunk_start_ordinal, chunk_end_ordinal, unprocessed_from,
                compartments_produced, compartment_id_min, compartment_id_max, facts_emitted,
                facts_by_category_json, events_emitted, importance_min, importance_max, importance_avg,
                discarded_last, legacy, created_at)
             VALUES (?1, ?2, ?3, 'incremental', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?18, ?19, ?20)",
            params![self.owner.session, self.owner.harness, turn_one, self.status, reason,
                chunk.map(|c| integer(c.first)), chunk.map(|c| integer(c.last)), self.reply.next.map(integer),
                output.map_or(0, |o| o.count), output.and_then(|o| o.first_id), output.and_then(|o| o.last_id),
                self.reply.facts.values().sum::<usize>(), counters.to_string(), self.reply.events,
                output.and_then(|o| o.importance_min), output.and_then(|o| o.importance_max),
                output.and_then(|o| o.importance_avg), self.reply.discarded_last, output.is_some_and(|o| o.legacy),
                self.ended_at],
        )?;
        tx.commit()
    }
}
