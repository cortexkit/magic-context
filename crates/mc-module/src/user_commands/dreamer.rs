//! The person's dreamer commands for a project: start a task now, and undo
//! every memory change one run made.

use std::sync::Arc;

use cortexkit_role_user_commands::{Fact, FactValue, Preview, Table, TableRow};
use rusqlite::OptionalExtension;
use serde_json::{json, Map};

use super::owner::{count, id, not_here, person_refused, plain, read, Context, Plan, Refused};
use super::*;
use crate::context_db::ContextDb;
use crate::dreamer::engine::RunNowRefused;
use crate::dreamer::store::{self as dream_store, OwnerKey};
use crate::memory_writes::person::{self, LeftAlone, OwnerRef};

type Stamp<'s> = &'s dyn Fn(Value) -> String;

/// A task kind as a person reads it: `classify-memories` is "Classify
/// memories".
fn task_label(kind: &str) -> String {
    let words = kind.replace('-', " ");
    let mut chars = words.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn refused_reason(refused: &RunNowRefused) -> Option<&'static str> {
    Some(match refused {
        RunNowRefused::NotSeen => "project_not_seen",
        RunNowRefused::NotDeclared => "task_not_declared",
        RunNowRefused::Disabled => "task_disabled",
        RunNowRefused::NotScheduled => "not_scheduled",
        RunNowRefused::Locked => "locked",
        RunNowRefused::Evidence(_) => "evidence_missing",
        RunNowRefused::Store(_) => return None,
    })
}

/// `dreamer_run_now {task}`: start the project's task of this kind now,
/// unless the project's lock is held. The run counts as the task's run.
pub(super) fn run_now<'a, C>(
    context: &'a Context<'a, C>,
    db: &'a Arc<ContextDb>,
    project: String,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody>
where
    C: crate::client::RunnerClient + crate::routing::Router + Send + Sync + 'static,
{
    let kind = args
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let now = crate::memory_writes::now_ms();
    let owner = OwnerKey::project(&project);
    // The version covers what decides whether and how the task starts: the
    // project's lock, its newest run and its schedules.
    let state = read(db, |conn| {
        let held = dream_store::lock_holder(conn, &owner, now)?.is_some();
        let newest: Option<i64> = conn
            .query_row(
                "SELECT id FROM dream_task_runs WHERE level = 'project' AND owner_id = ?1
                  ORDER BY id DESC LIMIT 1",
                [&project],
                |row| row.get(0),
            )
            .optional()?;
        let schedules: Vec<Value> = conn
            .prepare(
                "SELECT task, schedule, next_due_at, failures FROM dream_schedules
                  WHERE level = 'project' AND owner_id = ?1 ORDER BY task",
            )?
            .query_map([&project], |row| {
                Ok(json!([
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, i64>(3)?
                ]))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(json!({"held": held, "newest": newest, "schedules": schedules}))
    })?;
    let (Some(engine), Some(settings)) = (context.dreamer, context.dreamer_settings.clone()) else {
        return Ok(Plan::unavailable(
            stamp(json!({"state": state, "reason": "dreamer_off"})),
            "dreamer_off",
        ));
    };
    let checked = engine.run_now_check(db, &project, &kind, now);
    let reason = match &checked {
        Ok(_) => None,
        Err(refused) => Some(refused_reason(refused).ok_or_else(|| {
            tracing::warn!("ck-mc: user command dreamer_run_now: {refused:?}");
            super::owner::unavailable_error()
        })?),
    };
    let version = stamp(json!({"state": state, "reason": reason}));
    let due = match checked {
        Ok(due) => due,
        Err(_) => return Ok(Plan::unavailable(version, reason.unwrap_or("locked"))),
    };
    let mut preview = Preview::new(version, true);
    preview.effect = Some(format!(
        "Runs {} for this project now; it counts as the task's scheduled run.",
        task_label(&kind)
    ));
    preview.facts = Some(vec![count(
        "Failures in a row",
        due.failures.max(0) as usize,
        None,
    )]);
    let client = context.client;
    Ok(Plan::available(
        preview,
        Box::new(
            move || match engine.run_now(db, client, &settings, &project, &kind) {
                Ok((_, run)) => {
                    let mut reply = RunReply::new("started");
                    reply.facts = Some(vec![Fact::new("Dreamer run", plain(run))]);
                    Ok(reply)
                }
                Err(refused) => match refused_reason(&refused) {
                    Some(reason) => Err(Refused::Reply(RunReply::new(reason))),
                    None => Err(super::owner::store_failed(
                        "dreamer_run_now",
                        &format!("{refused:?}"),
                    )),
                },
            },
        ),
    ))
}

/// How the apps word a memory an undo leaves alone, and the state its row
/// shows.
fn left_alone(id: i64, why: LeftAlone) -> (String, &'static str, &'static str) {
    match why {
        LeftAlone::ChangedAfter => (
            format!("Memory {id} changed after the run"),
            "changed_after_run",
            "stale",
        ),
        LeftAlone::Deleted => (format!("Memory {id} was deleted"), "deleted", "unavailable"),
        LeftAlone::Moved => (
            format!("Memory {id} belongs to another owner now"),
            "moved",
            "off",
        ),
        LeftAlone::Duplicate => (
            format!("Memory {id} would repeat a live memory"),
            "duplicate",
            "unavailable",
        ),
    }
}

/// The most facts a run's answer carries.
const MAX_FACTS: usize = 16;

/// `dreamer_undo_run {run_id}`: revert every memory change the run made, as
/// one undo. A memory changed again since the run is left as it is, and the
/// answer names it with the reason.
pub(super) fn undo_run<'a>(
    db: &'a ContextDb,
    project: String,
    args: &Map<String, Value>,
    stamp: Stamp<'_>,
) -> Result<Plan<'a>, ErrorBody> {
    let run = id(args, "run_id")?;
    let found: Option<(String, String, Option<i64>)> = read(db, |conn| {
        conn.query_row(
            "SELECT level, owner_id, ended_at FROM dream_task_runs WHERE id = ?1",
            [run],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
    })?;
    let Some((_, _, ended)) =
        found.filter(|(level, owner, _)| level == "project" && *owner == project)
    else {
        return Err(not_here(
            "run_id",
            format!("Dreamer run {run} is not one of this project's runs."),
            &[run],
        ));
    };
    let owner = OwnerRef {
        level: "project".into(),
        owner_id: project,
    };
    let plan = read(db, |conn| person::plan_run_undo(conn, &owner, run))?;
    let version = stamp(json!({
        "ended": ended.is_some(),
        "restore": plan.restore.iter().map(|(target, _)| [target.id, target.revision]).collect::<Vec<_>>(),
        "left": plan.left.iter().map(|(id, why)| json!([id, left_alone(*id, *why).1])).collect::<Vec<_>>(),
    }));
    if ended.is_none() {
        return Ok(Plan::unavailable(version, "run_running"));
    }
    if plan.restore.is_empty() {
        return Ok(Plan::unavailable(version, "nothing_to_undo"));
    }
    let (restoring, leaving) = (plan.restore.len(), plan.left.len());
    let mut preview = Preview::new(version, true);
    let changes = if restoring == 1 {
        "1 memory change".to_owned()
    } else {
        format!("{restoring} memory changes")
    };
    preview.effect = Some(match leaving {
        0 => format!("Reverts {changes} of dreamer run {run} as one undo."),
        1 => format!(
            "Reverts {changes} of dreamer run {run} as one undo; 1 changed since stays as it is."
        ),
        _ => format!(
            "Reverts {changes} of dreamer run {run} as one undo; {leaving} changed since stay as they are."
        ),
    });
    preview.facts = Some(vec![
        count("Memories restored", restoring, Some("memories")),
        count("Left alone", leaving, Some("memories")),
    ]);
    let mut rows: Vec<TableRow> = plan
        .restore
        .iter()
        .map(|(target, _)| {
            TableRow::new(
                format!("Memory {}", target.id),
                vec![FactValue::state("ready")],
            )
        })
        .collect();
    rows.extend(plan.left.iter().map(|(id, why)| {
        let (label, _, state) = left_alone(*id, *why);
        TableRow::new(label, vec![FactValue::state(state)])
    }));
    rows.truncate(32);
    preview.table = Some(Table::new(vec!["Undo".into()], rows));
    Ok(Plan::available(
        preview,
        Box::new(move || {
            db.with_connection(|conn| person::undo_run(conn, &owner, run, &plan.restore))
                .map_err(|error| person_refused("dreamer_undo_run", error))?;
            db.changed(crate::app_read::Change::project_memories(&owner.owner_id));
            let mut facts = vec![
                count("Memories restored", restoring, Some("memories")),
                count("Left alone", leaving, Some("memories")),
            ];
            // Each memory left alone, with why, while the answer has room;
            // the last fact counts any it had no room to name.
            let room = MAX_FACTS - facts.len();
            let named = if leaving > room { room - 1 } else { leaving };
            for (id, why) in plan.left.iter().take(named) {
                let (label, _, state) = left_alone(*id, *why);
                facts.push(Fact::new(label, FactValue::state(state)));
            }
            if named < leaving {
                facts.push(count("More left alone", leaving - named, Some("memories")));
            }
            let mut reply = RunReply::new("applied");
            reply.facts = Some(facts);
            Ok(reply)
        }),
    ))
}
