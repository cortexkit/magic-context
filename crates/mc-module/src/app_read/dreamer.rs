//! Dreamer reads for the apps: a project's task schedules, its lock and
//! health, its runs newest first, and one run in full.
//!
//! The dreamer's own tables hold what it did ([`crate::dreamer::store`]);
//! the profile the engine resolved for the project, while this process has
//! seen it, adds each task's kind and whether the profile enables it. Every
//! query is bound to the project: the schedule and lock primary keys, and the
//! runs' owner index (`idx_dream_task_runs_owner`). A run's memory changes
//! are found through the journal rows its history keys name
//! (`dream-run:<id>:…`), a range on the journal's unique key index.

use std::collections::BTreeSet;

use rusqlite::types::Value as Sql;
use rusqlite::OptionalExtension;

use super::pages::{self, Keyset, Page};
use super::*;

/// The days of a week schedule, in the order the apps show them; a cron
/// day-of-week number indexes it (0 and 7 are both Sunday).
const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// A plain cron number: digits only, within `0..=max`.
fn plain(token: &str, max: u32) -> Option<u32> {
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    token.parse().ok().filter(|value| *value <= max)
}

/// A day-of-week field made only of days and day ranges (`1-5`, `0,6`),
/// as the days it names in week order (Monday first). `None` for anything
/// else, including steps and `*`.
fn week_days(token: &str) -> Option<Vec<&'static str>> {
    let mut named = [false; 7];
    for piece in token.split(',') {
        let (low, high) = match piece.split_once('-') {
            Some((low, high)) => (plain(low, 7)?, plain(high, 7)?),
            None => {
                let day = plain(piece, 7)?;
                (day, day)
            }
        };
        if low > high {
            return None;
        }
        for day in low..=high {
            named[day as usize % 7] = true;
        }
    }
    let days: Vec<&'static str> = [1, 2, 3, 4, 5, 6, 0]
        .into_iter()
        .filter(|day| named[*day])
        .map(|day| DAYS[day])
        .collect();
    (!days.is_empty()).then_some(days)
}

/// A stored cron expression in the structured form the apps word: every
/// hour at a minute, every day at a time, or on some weekdays at a time.
/// Any expression that is not exactly one of those (a step, a list of
/// minutes or hours, a day of the month, a month) stays `{cron}`. Each form
/// names the time zone the schedule runs in, when it is known.
pub(crate) fn schedule(expression: &str, zone: Option<&str>) -> Value {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    let form = match fields.as_slice() {
        [minute, "*", "*", "*", "*"] => {
            plain(minute, 59).map(|minute| json!({"every": "hour", "minute": minute}))
        }
        [minute, hour, "*", "*", weekday] => {
            plain(minute, 59)
                .zip(plain(hour, 23))
                .and_then(|(minute, hour)| {
                    let at = format!("{hour:02}:{minute:02}");
                    if *weekday == "*" {
                        Some(json!({"every": "day", "at": at}))
                    } else {
                        week_days(weekday)
                            .map(|days| json!({"every": "week", "days": days, "at": at}))
                    }
                })
        }
        _ => None,
    };
    let mut form = form.unwrap_or_else(|| json!({"cron": expression}));
    pages::put(&mut form, "time_zone", zone.map(Value::from));
    form
}

/// A run's failure class. Every failed run carries one: the ones the run
/// recorded, and for a run that lost its project's lock or was cut short by
/// a stopped process, that outcome.
fn failure_class(outcome: Option<&str>, recorded: Option<String>) -> Option<String> {
    recorded.or_else(|| match outcome {
        Some(outcome @ ("lock_lost" | "interrupted")) => Some(outcome.to_owned()),
        _ => None,
    })
}

/// What a run's history rows changed: memories written (added or edited),
/// merged into another, and archived; and every memory it changed.
struct Changes {
    written: i64,
    merged: i64,
    archived: i64,
    ids: BTreeSet<i64>,
}

fn changes(conn: &Connection, run: i64) -> Result<Changes, Refusal> {
    let decisions: Vec<Option<String>> = conn
        .prepare(
            "SELECT before_json FROM memory_journal
              WHERE decision_key >= ?1 AND decision_key < ?2 ORDER BY decision_key",
        )
        .and_then(|mut statement| {
            statement
                .query_map(
                    params![format!("dream-run:{run}:"), format!("dream-run:{run};")],
                    |row| row.get(0),
                )?
                .collect()
        })
        .map_err(pages::store_error)?;
    let mut changes = Changes {
        written: 0,
        merged: 0,
        archived: 0,
        ids: BTreeSet::new(),
    };
    for decision in decisions.iter().flatten() {
        let Ok(decision) = serde_json::from_str::<Value>(decision) else {
            continue;
        };
        for row in decision["rows"].as_array().into_iter().flatten() {
            let (before, after) = (&row["before"], &row["after"]);
            if after.is_null() || before == after {
                continue;
            }
            if let Some(id) = row["memoryId"].as_i64() {
                changes.ids.insert(id);
            }
            if !before.is_null()
                && before["supersededByMemoryId"].is_null()
                && !after["supersededByMemoryId"].is_null()
            {
                changes.merged += 1;
            } else if !before.is_null()
                && before["status"] != "archived"
                && after["status"] == "archived"
            {
                changes.archived += 1;
            } else {
                changes.written += 1;
            }
        }
    }
    Ok(changes)
}

const RUN_COLUMNS: &str = "id, task, kind, started_at, ended_at, outcome, failure_class, error,
    input_tokens, output_tokens, proposed, applied, dropped_json, batches_json, owner_id";

struct Run {
    id: i64,
    task: String,
    kind: String,
    started_at: i64,
    ended_at: Option<i64>,
    outcome: Option<String>,
    failure_class: Option<String>,
    error: Option<String>,
    input: i64,
    output: i64,
    proposed: i64,
    applied: i64,
    dropped: Option<String>,
    batches: Option<String>,
    owner: String,
}

fn run_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        task: row.get(1)?,
        kind: row.get(2)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        outcome: row.get(5)?,
        failure_class: row.get(6)?,
        error: row.get(7)?,
        input: row.get(8)?,
        output: row.get(9)?,
        proposed: row.get(10)?,
        applied: row.get(11)?,
        dropped: row.get(12)?,
        batches: row.get(13)?,
        owner: row.get(14)?,
    })
}

impl Run {
    /// Each message the run sent. A waiting run also records the wait it
    /// met there, which sent nothing and is not a batch.
    fn batches(&self) -> Vec<Value> {
        self.batches
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<Value>>(json).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|batch| batch["model"].is_string())
            .collect()
    }

    /// The run as the run list shows it.
    fn summary(&self, conn: &Connection) -> Result<Value, Refusal> {
        let changes = changes(conn, self.id)?;
        let mut models: Vec<String> = Vec::new();
        for batch in self.batches() {
            if let Some(model) = batch["model"].as_str() {
                if !models.iter().any(|known| known == model) {
                    models.push(model.to_owned());
                }
            }
        }
        let mut row = json!({
            "id": self.id,
            "task": self.task,
            "kind": self.kind,
            "started_at": self.started_at,
            // A run with no end yet is still going.
            "outcome": self.outcome.as_deref().unwrap_or("running"),
            "tokens": {"input": self.input, "output": self.output},
            "proposed": self.proposed,
            "applied": self.applied,
            "changes": {"written": changes.written, "merged": changes.merged, "archived": changes.archived},
            "models": models,
        });
        pages::put(&mut row, "ended_at", self.ended_at.map(Value::from));
        pages::put(
            &mut row,
            "duration_ms",
            self.ended_at
                .map(|ended| Value::from(ended - self.started_at)),
        );
        pages::put(
            &mut row,
            "failure_class",
            failure_class(self.outcome.as_deref(), self.failure_class.clone()).map(Value::from),
        );
        pages::put(&mut row, "error", self.error.clone().map(Value::from));
        Ok(row)
    }
}

impl Replica {
    fn dreamer_project<'a>(&self, p: &'a Map<String, Value>) -> Result<&'a str, Refusal> {
        let project = string(p, "project")?;
        if !self.apps.knows(project) {
            return Err(pages::project_unknown());
        }
        Ok(project)
    }

    /// `dreamer.status {project}`.
    pub(super) fn dreamer_status(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let project = self.dreamer_project(p)?;
        let conn = self.context.as_ref().ok_or_else(pages::store_unavailable)?;
        let now = now_ms() as i64;
        let zone = (self.apps.zone)();
        let engine = self
            .apps
            .attached
            .as_ref()
            .and_then(|attached| attached.dreamer.as_ref());
        let newest_run = |task: &str, open: bool| -> Result<Option<Run>, Refusal> {
            conn.query_row(
                &format!(
                    "SELECT {RUN_COLUMNS} FROM dream_task_runs
                      WHERE level = 'project' AND owner_id = ?1 AND task = ?2 {}
                      ORDER BY started_at DESC, id DESC LIMIT 1",
                    if open { "AND ended_at IS NULL" } else { "" }
                ),
                params![project, task],
                run_row,
            )
            .optional()
            .map_err(pages::store_error)
        };
        let mut reply = json!({"project": project, "config_source": "user"});
        if let Some(attached) = &self.apps.attached {
            reply["enabled"] = json!(attached.config.dreamer().is_some());
        }
        let lock: Option<(String, i64, i64)> = conn
            .query_row(
                "SELECT task, acquired_at, expires_at FROM dream_locks
                  WHERE level = 'project' AND owner_id = ?1",
                params![project],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(pages::store_error)?;
        // A lock past its expiry is free to take; no writer holds it.
        if let Some((task, since, _)) = lock.filter(|(_, _, expires)| *expires > now) {
            let mut held = json!({"task": task, "since": since});
            pages::put(
                &mut held,
                "run_id",
                newest_run(&task, true)?.map(|run| Value::from(run.id)),
            );
            reply["lock"] = held;
        }
        type ScheduleRow = (
            String,
            String,
            Option<i64>,
            Option<i64>,
            Option<String>,
            Option<String>,
            i64,
        );
        let schedules: Vec<ScheduleRow> = conn
            .prepare(
                "SELECT task, schedule, next_due_at, last_run_at, last_status, last_error, failures
                   FROM dream_schedules WHERE level = 'project' AND owner_id = ?1 ORDER BY task",
            )
            .and_then(|mut statement| {
                statement
                    .query_map(params![project], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    })?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let (mut failing, mut waiting) = (false, false);
        let mut tasks = Vec::new();
        for (task, expression, next_due_at, last_run_at, last_status, last_error, failures) in
            schedules
        {
            let declared = engine.and_then(|engine| engine.declared(project, &task));
            let newest = newest_run(&task, false)?;
            let kind = declared
                .as_ref()
                .map(|(kind, _)| kind.clone())
                .or_else(|| newest.as_ref().map(|run| run.kind.clone()));
            let switched_on = !expression.trim().is_empty();
            let mut row = json!({
                "task": task,
                "enabled": switched_on && declared.as_ref().is_none_or(|(_, enabled)| *enabled),
                "overdue": next_due_at.is_some_and(|due| due <= now),
                "failures_in_a_row": failures,
            });
            pages::put(&mut row, "kind", kind.map(Value::from));
            if switched_on {
                row["schedule"] = schedule(&expression, zone.as_deref());
            }
            pages::put(&mut row, "next_due_at", next_due_at.map(Value::from));
            let last = match last_status.as_deref() {
                // Settled since the newest run: the schedule's own record.
                Some(status) => {
                    let mut last = json!({"status": status});
                    let at = match status {
                        "waiting" => newest.as_ref().and_then(|run| run.ended_at),
                        "skipped" => None,
                        _ => last_run_at,
                    };
                    pages::put(&mut last, "at", at.map(Value::from));
                    if status == "failed" {
                        // A failure with no failed run behind it happened
                        // before a run could be recorded: the store refused
                        // the lock or the run record.
                        let class = newest
                            .as_ref()
                            .filter(|run| {
                                matches!(run.outcome.as_deref(), Some("failed" | "lock_lost"))
                            })
                            .and_then(|run| {
                                failure_class(run.outcome.as_deref(), run.failure_class.clone())
                            })
                            .unwrap_or_else(|| "store".into());
                        last["failure_class"] = json!(class);
                    }
                    pages::put(&mut last, "error", last_error.map(Value::from));
                    Some(last)
                }
                None => newest
                    .as_ref()
                    .filter(|run| run.ended_at.is_some())
                    .map(|run| {
                        let mut last =
                            json!({"status": run.outcome.as_deref().unwrap_or("running")});
                        pages::put(&mut last, "at", run.ended_at.map(Value::from));
                        pages::put(
                            &mut last,
                            "failure_class",
                            failure_class(run.outcome.as_deref(), run.failure_class.clone())
                                .map(Value::from),
                        );
                        pages::put(&mut last, "error", run.error.clone().map(Value::from));
                        last
                    }),
            };
            pages::put(&mut row, "last", last);
            // An account limit names the time to ask again in the run that
            // met it.
            let waiting_until = (last_status.as_deref() == Some("waiting"))
                .then(|| {
                    newest
                        .as_ref()
                        .filter(|run| run.outcome.as_deref() == Some("waiting"))
                        .and_then(|run| {
                            run.batches
                                .as_deref()
                                .and_then(|json| serde_json::from_str::<Vec<Value>>(json).ok())
                                .and_then(|batches| batches.last()?["wait_until"].as_i64())
                        })
                })
                .flatten();
            pages::put(&mut row, "waiting_until", waiting_until.map(Value::from));
            failing |= failures >= 3;
            waiting |= waiting_until.is_some_and(|until| until > now);
            tasks.push(row);
        }
        reply["tasks"] = Value::Array(tasks);
        reply["health"] = json!(if failing {
            "failing"
        } else if waiting {
            "waiting"
        } else {
            "ok"
        });
        Ok(reply)
    }

    /// `dreamer.runs {project, task?, cursor?, limit?}`: newest first.
    pub(super) fn dreamer_runs(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let project = self.dreamer_project(p)?;
        let task = pages::optional(p, "task")?;
        let limit = pages::limit(p, 50)?;
        let keyset = Keyset::new("dreamer.runs", &json!([project, task]));
        let after = keyset.after(p, "ii")?;
        let conn = self.context.as_ref().ok_or_else(pages::store_unavailable)?;
        let mut sql = format!(
            "SELECT {RUN_COLUMNS} FROM dream_task_runs WHERE level = 'project' AND owner_id = ?"
        );
        let mut binds: Vec<Sql> = vec![Sql::Text(project.into())];
        if let Some(task) = task {
            sql.push_str(" AND task = ?");
            binds.push(Sql::Text(task.into()));
        }
        if let Some(after) = after {
            sql.push_str(" AND (started_at < ? OR (started_at = ? AND id < ?))");
            binds.extend([after[0].clone(), after[0].clone(), after[1].clone()]);
        }
        sql.push_str(" ORDER BY started_at DESC, id DESC LIMIT ?");
        binds.push(Sql::Integer(limit as i64 + 1));
        let runs: Vec<Run> = conn
            .prepare(&sql)
            .and_then(|mut statement| {
                statement
                    .query_map(rusqlite::params_from_iter(binds), run_row)?
                    .collect()
            })
            .map_err(pages::store_error)?;
        let mut page = Page::new(limit);
        for run in runs {
            let key = vec![Sql::Integer(run.started_at), Sql::Integer(run.id)];
            if !page.push(run.summary(conn)?, key)? {
                break;
            }
        }
        let mut reply = page.finish(&keyset, "runs");
        reply["project"] = json!(project);
        Ok(reply)
    }

    /// `dreamer.run {id}`: one run with every batch it sent, each proposal
    /// it dropped and why, and the memories it changed.
    pub(super) fn dreamer_run(&self, p: &Map<String, Value>) -> Result<Value, Refusal> {
        let id = pages::id(p, "id")?;
        let conn = self.context.as_ref().ok_or_else(pages::store_unavailable)?;
        let run = conn
            .query_row(
                &format!("SELECT {RUN_COLUMNS} FROM dream_task_runs WHERE id = ?1"),
                params![id],
                run_row,
            )
            .optional()
            .map_err(pages::store_error)?
            .ok_or_else(|| error("run_not_found", "No dreamer run matches the id."))?;
        let mut row = run.summary(conn)?;
        row["project"] = json!(run.owner);
        row["batches"] = Value::Array(
            run.batches()
                .into_iter()
                .map(|batch| {
                    let mut out = json!({
                        "model": batch["model"],
                        "tokens": {
                            "input": batch["input_tokens"].as_i64().unwrap_or(0),
                            "output": batch["output_tokens"].as_i64().unwrap_or(0),
                        },
                    });
                    pages::put(&mut out, "runner", Some(batch["runner"].clone()));
                    pages::put(&mut out, "child_session", Some(batch["child"].clone()));
                    out
                })
                .collect(),
        );
        row["dropped"] = Value::Array(
            run.dropped
                .as_deref()
                .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|reason| {
                    // Each task words a dropped proposal as `memory <id> …`.
                    let memory = reason
                        .strip_prefix("memory ")
                        .map(|rest| {
                            rest.chars()
                                .take_while(char::is_ascii_digit)
                                .collect::<String>()
                        })
                        .and_then(|digits| digits.parse::<i64>().ok());
                    let mut out = json!({"reason": reason});
                    pages::put(&mut out, "memory_id", memory.map(Value::from));
                    out
                })
                .collect(),
        );
        row["changed_memory_ids"] = json!(changes(conn, run.id)?.ids);
        Ok(json!({"run": row}))
    }
}
