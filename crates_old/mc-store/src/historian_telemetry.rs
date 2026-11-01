//! Best-effort historian accounting in the host's existing telemetry tables.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::McStore;

/// One model call, including a failed or empty fallback attempt.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistorianInvocation {
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: i64,
    pub status: String,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub cache_read_tokens: i64,
    #[serde(default)]
    pub cache_write_tokens: i64,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct HistorianRunTelemetry {
    pub invocation_id: Option<i64>,
    pub started_at: i64,
    pub run_kind: String,
    pub status: String,
    pub failure_reason: Option<String>,
    pub chunk_start_ordinal: Option<u64>,
    pub chunk_end_ordinal: Option<u64>,
    pub unprocessed_from: Option<u64>,
    pub compartments_produced: usize,
    pub facts_emitted: usize,
    pub facts_by_category: Value,
    pub facts_promoted: usize,
    pub events_emitted: usize,
    pub events_created_at: i64,
    pub importance_min: Option<i64>,
    pub importance_max: Option<i64>,
    pub importance_avg: Option<f64>,
    pub discarded_last: bool,
    pub created_at: i64,
}

impl McStore {
    /// Record model attempts without waiting for the context.db writer lock. Insert errors
    /// are logged here instead of becoming compartment-publication errors.
    pub fn record_historian_invocations(
        &self,
        session_id: &str,
        harness: &str,
        subagent: &str,
        attempts: &[HistorianInvocation],
        parent_id: Option<i64>,
    ) -> Option<i64> {
        self.record_invocations(session_id, harness, subagent, attempts, parent_id, None)
    }

    /// A restarted historian can re-read output recorded before the process crashed.
    /// Preserve that invocation rather than counting the same model call twice.
    pub fn record_missing_historian_invocation(
        &self,
        session_id: &str,
        harness: &str,
        attempt: &HistorianInvocation,
    ) -> Option<i64> {
        self.record_invocations(
            session_id,
            harness,
            "historian",
            std::slice::from_ref(attempt),
            None,
            Some(attempt.started_at),
        )
    }

    fn record_invocations(
        &self,
        session_id: &str,
        harness: &str,
        subagent: &str,
        attempts: &[HistorianInvocation],
        mut parent_id: Option<i64>,
        existing_since: Option<i64>,
    ) -> Option<i64> {
        let result = self.context_domain().and_then(|domain| {
            domain.try_write(&["subagent_invocations"], &mut |tx| {
                if let Some(since) = existing_since {
                    parent_id = tx
                        .query_row(
                            "SELECT id FROM subagent_invocations WHERE session_id = ?1
                        AND subagent = ?2 AND started_at >= ?3 ORDER BY id DESC LIMIT 1",
                            params![session_id, subagent, since],
                            |r| r.get(0),
                        )
                        .optional()?;
                    if parent_id.is_some() {
                        return Ok(());
                    }
                }
                for attempt in attempts {
                    tx.execute(
                        "INSERT INTO subagent_invocations
                         (session_id, harness, subagent, task, provider_id, model_id,
                          started_at, ended_at, status, input_tokens, output_tokens,
                          cache_read_tokens, cache_write_tokens, error, parent_invocation_id)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                        params![
                            session_id,
                            harness,
                            subagent,
                            parent_id.map(|_| "fallback"),
                            attempt.provider_id,
                            attempt.model_id,
                            attempt.started_at,
                            attempt.ended_at,
                            attempt.status,
                            attempt.input_tokens.max(0),
                            attempt.output_tokens.max(0),
                            attempt.cache_read_tokens.max(0),
                            attempt.cache_write_tokens.max(0),
                            attempt.error,
                            parent_id
                        ],
                    )?;
                    parent_id = Some(tx.last_insert_rowid());
                }
                Ok(())
            })
        });
        match result {
            Ok(()) => parent_id,
            Err(error) => {
                eprintln!(
                    "[mc-store][{session_id}] could not record historian invocation: {error}"
                );
                None
            }
        }
    }

    pub fn record_historian_run(
        &self,
        session_id: &str,
        harness: &str,
        run: &HistorianRunTelemetry,
    ) {
        let result = self.context_domain().and_then(|domain| {
            domain.try_write(&["historian_runs"], &mut |tx| {
                let invocation_id = match run.invocation_id {
                    Some(id) => Some(id),
                    None => tx.query_row(
                        "SELECT id FROM subagent_invocations WHERE session_id = ?1
                         AND subagent IN ('historian','recomp') AND started_at >= ?2
                         ORDER BY id DESC LIMIT 1",
                        params![session_id, run.started_at], |row| row.get(0),
                    ).optional().unwrap_or(None),
                };
                let (id_min, id_max, compartments_produced): (Option<i64>, Option<i64>, i64) = if run.compartments_produced > 0 {
                    tx.query_row(
                        "SELECT MIN(id), MAX(id), COUNT(*) FROM compartments WHERE session_id = ?1
                         AND start_message >= ?2 AND end_message <= ?3",
                        params![session_id, run.chunk_start_ordinal, run.chunk_end_ordinal],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )?
                } else { (None, None, 0) };
                let events_published: i64 = if run.events_emitted > 0 {
                    tx.query_row("SELECT COUNT(*) FROM compartment_events WHERE session_id = ?1
                        AND created_at = ?2", params![session_id,run.events_created_at], |r| r.get::<_,i64>(0))?
                        .min(run.events_emitted as i64)
                } else { 0 };
                let mut categories = run.facts_by_category.as_object().cloned().unwrap_or_default();
                categories.insert("facts_promoted".into(), run.facts_promoted.into());
                categories.insert("events_published".into(), events_published.into());
                tx.execute(
                    "INSERT INTO historian_runs
                     (session_id,harness,subagent_invocation_id,run_kind,status,failure_reason,
                      chunk_start_ordinal,chunk_end_ordinal,unprocessed_from,compartments_produced,
                      compartment_id_min,compartment_id_max,facts_emitted,facts_by_category_json,
                      events_emitted,importance_min,importance_max,importance_avg,discarded_last,legacy,created_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,0,?20)",
                    params![session_id,harness,invocation_id,run.run_kind,run.status,run.failure_reason,
                        run.chunk_start_ordinal,run.chunk_end_ordinal,run.unprocessed_from,
                        compartments_produced,id_min,id_max,run.facts_emitted as i64,
                        Value::Object(categories).to_string(),run.events_emitted as i64,
                        run.importance_min,run.importance_max,run.importance_avg,run.discarded_last,run.created_at],
                )?;
                Ok(())
            })
        });
        if let Err(error) = result {
            eprintln!("[mc-store][{session_id}] could not record historian run: {error}");
        }
    }
}
