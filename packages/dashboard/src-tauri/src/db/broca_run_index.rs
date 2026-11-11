//! Incremental session summaries from Broca's append-only public export.
//! A cursor belongs to one source instance and epoch; file replacement is also
//! checked by the caller. No connection or read transaction survives a poll.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::time::Instant;

const PAGE_SIZE: usize = 512;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SessionIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_root: Option<String>,
    pub harness: String,
    pub session: String,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct UsageTotals {
    pub input_tokens: Option<u64>,
    pub cached_input_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl UsageTotals {
    fn add(&mut self, other: &Self) {
        fn add(total: &mut Option<u64>, value: Option<u64>) {
            if let Some(value) = value {
                *total = Some(total.unwrap_or_default().saturating_add(value));
            }
        }
        add(&mut self.input_tokens, other.input_tokens);
        add(&mut self.cached_input_tokens, other.cached_input_tokens);
        add(&mut self.cache_write_tokens, other.cache_write_tokens);
        // Broca's output already includes reasoning tokens.
        add(&mut self.output_tokens, other.output_tokens);
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct BrocaSessionSummary {
    pub session: SessionIdentity,
    pub first_activity_ms: Option<u64>,
    pub last_activity_ms: Option<u64>,
    pub models: Vec<String>,
    pub run_count: usize,
    pub slice_count: usize,
    pub usage: UsageTotals,
    pub warm_usage: UsageTotals,
    pub last_end_reason: Option<String>,
}

#[derive(Deserialize)]
struct SessionFact {
    session: SessionIdentity,
    provider: String,
    model: String,
    usage: UsageTotals,
    occurred_at_ms: Option<u64>,
    terminal_reason: Option<String>,
    #[serde(default)]
    warm: bool,
}

#[derive(Debug, Default)]
struct RunEnd {
    activity: Option<u64>,
    // Export order makes equal-time choices deterministic, not chronological.
    last_seq: i64,
    reason: Option<String>,
}

#[derive(Debug)]
struct SessionFacts {
    summary: BrocaSessionSummary,
    runs: HashMap<String, RunEnd>,
    models: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ListedSession {
    pub identity: String,
    pub activity: Option<u64>,
    pub summary: BrocaSessionSummary,
}

#[derive(Debug, Default)]
pub(super) struct BrocaRunIndex {
    source: Option<(String, i64)>,
    export_seq: i64,
    sessions: HashMap<String, SessionFacts>,
    list_memo: Option<(i64, usize, Vec<ListedSession>)>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct PollStats {
    pub rows_read: usize,
    pub skipped_invalid: usize,
}

impl BrocaRunIndex {
    /// Metadata and pages share one short snapshot so a source reset cannot
    /// mix the old source's facts into the new source's cursor.
    pub(super) fn refresh(
        &mut self,
        conn: &Connection,
        _now: Instant,
    ) -> rusqlite::Result<PollStats> {
        let transaction = conn.unchecked_transaction()?;
        let source = transaction.query_row(
            "SELECT source_instance_id, source_epoch FROM export_meta WHERE id = 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )?;
        if self.source.as_ref() != Some(&source) {
            *self = Self {
                source: Some(source),
                ..Self::default()
            };
        }
        let mut stats = PollStats::default();
        {
            let mut statement = transaction.prepare(
                "SELECT export_seq, run_id, segment_json FROM export_facts
                 WHERE export_seq > ?1 ORDER BY export_seq ASC LIMIT ?2",
            )?;
            loop {
                let mut count = 0;
                let mut rows = statement.query(params![self.export_seq, PAGE_SIZE])?;
                while let Some(row) = rows.next()? {
                    self.export_seq = row.get(0)?;
                    stats.rows_read += 1;
                    count += 1;
                    let json: String = row.get(2)?;
                    let value = match serde_json::from_str::<serde_json::Value>(&json) {
                        Ok(value) => value,
                        Err(_) => {
                            stats.skipped_invalid += 1;
                            continue;
                        }
                    };
                    if value["kind"] == "system_one" {
                        continue;
                    }
                    match serde_json::from_value::<SessionFact>(value) {
                        Ok(fact) => self.add(row.get(1)?, fact),
                        Err(_) => stats.skipped_invalid += 1,
                    }
                }
                if count < PAGE_SIZE {
                    break;
                }
            }
        }
        transaction.commit()?;
        if stats.skipped_invalid > 0 {
            eprintln!(
                "Broca export: skipped {} undecodable rows in this poll",
                stats.skipped_invalid
            );
        }
        Ok(stats)
    }

    fn add(&mut self, run_id: String, fact: SessionFact) {
        // Value's sorted object keys give old callers the same canonical JSON
        // identity regardless of the writer's member order or extra members.
        let identity = serde_json::to_value(&fact.session)
            .expect("serializable session")
            .to_string();
        let session = self
            .sessions
            .entry(identity)
            .or_insert_with(|| SessionFacts {
                summary: BrocaSessionSummary {
                    session: fact.session,
                    first_activity_ms: None,
                    last_activity_ms: None,
                    models: Vec::new(),
                    run_count: 0,
                    slice_count: 0,
                    usage: UsageTotals::default(),
                    warm_usage: UsageTotals::default(),
                    last_end_reason: None,
                },
                runs: HashMap::new(),
                models: BTreeSet::new(),
            });
        session
            .models
            .insert(format!("{}/{}", fact.provider, fact.model));
        if fact.warm {
            session.summary.warm_usage.add(&fact.usage);
            return;
        }
        let summary = &mut session.summary;
        summary.usage.add(&fact.usage);
        summary.slice_count += 1;
        if let Some(time) = fact.occurred_at_ms {
            summary.first_activity_ms =
                Some(summary.first_activity_ms.map_or(time, |old| old.min(time)));
            summary.last_activity_ms =
                Some(summary.last_activity_ms.map_or(time, |old| old.max(time)));
        }
        let run = session.runs.entry(run_id).or_default();
        run.activity = run.activity.max(fact.occurred_at_ms);
        run.last_seq = self.export_seq;
        if fact.terminal_reason.is_some() {
            run.reason = fact.terminal_reason;
        }
    }

    pub(super) fn list(&mut self, limit: usize) -> Vec<ListedSession> {
        if let Some((seq, cached_limit, listed)) = &self.list_memo {
            if *seq == self.export_seq && *cached_limit == limit {
                return listed.clone();
            }
        }
        // Rank cheap references first: a store can have thousands of sessions,
        // but only the visible page needs cloned summaries and model lists.
        let mut ranked: Vec<_> = self
            .sessions
            .iter()
            .map(|(identity, facts)| (facts.summary.last_activity_ms, identity))
            .collect();
        let order = |a: &(Option<u64>, &String), b: &(Option<u64>, &String)| {
            b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1))
        };
        if ranked.len() > limit {
            ranked.select_nth_unstable_by(limit, order);
            ranked.truncate(limit);
        }
        ranked.sort_unstable_by(order);
        let listed: Vec<_> = ranked
            .into_iter()
            .map(|(activity, identity)| ListedSession {
                identity: identity.clone(),
                activity,
                summary: self.summary(identity).expect("indexed session"),
            })
            .collect();
        self.list_memo = Some((self.export_seq, limit, listed.clone()));
        listed
    }

    pub(super) fn summary(&self, identity: &str) -> Option<BrocaSessionSummary> {
        let facts = self.sessions.get(identity)?;
        let mut summary = facts.summary.clone();
        summary.models = facts.models.iter().cloned().collect();
        summary.run_count = facts.runs.len();
        // Broca's undated facts are historical work whose end time was never
        // recorded. They cannot supersede a dated run or establish a newest
        // run by export order alone when the whole session is undated.
        summary.last_end_reason = facts
            .runs
            .values()
            .filter(|run| run.activity.is_some())
            .max_by_key(|run| (run.activity, run.last_seq))
            .and_then(|run| run.reason.clone());
        Some(summary)
    }

    pub(super) fn run_ids(&self, identity: &str) -> Vec<String> {
        let mut ids: Vec<_> = self
            .sessions
            .get(identity)
            .map(|facts| facts.runs.keys().cloned().collect())
            .unwrap_or_default();
        ids.sort_unstable();
        ids
    }
}
